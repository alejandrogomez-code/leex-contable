/* ============================================================================
 * FACTURA LEEX — Generación de Commercial Invoice (PDF + Excel) desde una venta
 * ----------------------------------------------------------------------------
 * Módulo autónomo. Depende de variables/funciones globales de index.html:
 *   C, sbGet, sbPost, sbPatchWhere, toast, fmtN, escapeHtml, clienteName
 *   jsPDF (window.jspdf), XLSX (SheetJS)
 *
 * Numeración correlativa: se guarda en la tabla `configuracion` (clave/valor)
 *   - factura_prefijo        -> ej "LEEX-CI-"
 *   - factura_numero_actual  -> último número EMITIDO (entero). El próximo = +1
 *   - factura_relleno        -> cantidad de dígitos con ceros a la izquierda (ej 9 => 000000001)
 *   - factura_sufijo_serie   -> ej "-001" (opcional, va al final)
 *   Formato final por defecto reproduce el del PDF: LEEX-CI-251002-001
 * ==========================================================================*/

(function(){
  'use strict';

  // ---- Datos del emisor (LEEX LLC), tomados del PDF de referencia ----
  var EMISOR = {
    nombre: 'LEEX LLC',
    tel: '1 305 507 8008',
    web: 'leexmedical.com',
    direccion: '7950 NW 53RD ST STE 337, MIAMI, FL33166, US',
    from: 'Shenzhen, China'
  };

  // ---- Datos bancarios (leyenda al pie de la factura) ----
  var BANCO = {
    cuenta: '1200027418',
    denominacion: 'LEEX LLC',
    domicilio: '7950 NW 53RD ST STE 337 MIAMI F',
    ciudad: 'Miami',
    pais: 'U.S.A.',
    swift: 'IFBKUS3MXXX',
    banco: 'INTERNATIONAL FINANCE BANK'
  };

  // ============================================================
  // Config de numeración (lectura desde C.config con defaults)
  // ============================================================
  function cfgFactura(){
    var c = (typeof C!=='undefined' && C.config) || {};
    return {
      prefijo:  c.factura_prefijo != null ? c.factura_prefijo : 'LEEX-CI-',
      actual:   c.factura_numero_actual != null && c.factura_numero_actual !== '' ? parseInt(c.factura_numero_actual,10) : 0,
      relleno:  c.factura_relleno != null && c.factura_relleno !== '' ? parseInt(c.factura_relleno,10) : 6,
      sufijo:   c.factura_sufijo_serie != null ? c.factura_sufijo_serie : '-001'
    };
  }

  // Devuelve el string del PRÓXIMO número (sin consumirlo)
  function proximoNumeroStr(){
    var f = cfgFactura();
    var n = (isNaN(f.actual)?0:f.actual) + 1;
    return formatearNumero(n, f);
  }
  function formatearNumero(n, f){
    f = f || cfgFactura();
    var relleno = isNaN(f.relleno)?6:f.relleno;
    var num = String(n);
    while(num.length < relleno) num = '0' + num;
    return (f.prefijo||'') + num + (f.sufijo||'');
  }

  // Upsert de una clave en `configuracion`
  function upsertCfg(clave, valor){
    return sbGet('configuracion','select=clave&clave=eq.'+clave).then(function(r){
      if(Array.isArray(r) && r.length > 0){
        return sbPatchWhere('configuracion','clave',clave,{valor:String(valor)});
      }else{
        return sbPost('configuracion',{clave:clave,valor:String(valor)});
      }
    });
  }

  // Consume el próximo número: incrementa factura_numero_actual y actualiza C.config
  function consumirNumero(){
    var f = cfgFactura();
    var n = (isNaN(f.actual)?0:f.actual) + 1;
    return upsertCfg('factura_numero_actual', n).then(function(){
      if(typeof C!=="undefined" && C.config) C.config.factura_numero_actual = n;
      return { entero:n, str: formatearNumero(n, f) };
    });
  }

  // ============================================================
  // Armado de datos de la factura desde una venta
  // ============================================================
  // Devuelve {cliente, items:[{desc,qty,unit,amount}], total, moneda}
  function datosDesdeVenta(venta){
    var cliente = (C.clientes||[]).find(function(x){return x.id===venta.cliente_id;}) || {};
    // Equipos vendidos: stock_items con venta_id === venta.id
    var equipos = (C.stock_items||[]).filter(function(it){return it.venta_id===venta.id;});

    // Agrupar equipos idénticos (misma descripción + mismo precio unitario) para
    // reproducir el formato "N units" del PDF de referencia.
    var mapa = {};
    equipos.forEach(function(it){
      var desc = descripcionEquipo(it);
      var unit = parseFloat(it.precio_venta_usd)||0;
      var key = desc + '||' + unit;
      if(!mapa[key]) mapa[key] = { desc:desc, qty:0, unit:unit, amount:0 };
      mapa[key].qty += 1;
      mapa[key].amount += unit;
    });
    var items = Object.keys(mapa).map(function(k){return mapa[k];});

    // Si no hay equipos asociados, usar una línea genérica con el importe de la venta
    if(items.length===0){
      var imp = parseFloat(venta.importe_usd)||parseFloat(venta.importe_total)||0;
      items.push({ desc: venta.tipo_operacion || 'Equipamiento médico', qty:1, unit:imp, amount:imp });
    }

    var totalEquipos = items.reduce(function(s,i){return s+i.amount;},0);
    // Priorizar el importe cargado en la venta si difiere (por descuentos, etc.)
    var totalVenta = parseFloat(venta.importe_usd)||0;
    var total = totalVenta>0 ? totalVenta : totalEquipos;

    return {
      cliente: cliente,
      items: items,
      total: total,
      moneda: 'USD',
      venta: venta
    };
  }

  function descripcionEquipo(it){
    // Preferir modelo; si no, SKU/PN. Sumar descripción extra si existe.
    var base = it.modelo || it.sku_leex || it.pn_fabrica || 'Equipo';
    var extra = it.descripcion || it.detalle || '';
    if(extra && extra.toLowerCase().indexOf(base.toLowerCase())===-1) base += ' (' + extra + ')';
    return base;
  }

  // Número en palabras (inglés, estilo del PDF de referencia)
  function numeroEnPalabras(n){
    n = Math.round(parseFloat(n)||0);
    var ones=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
    var tens=['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
    function tresCifras(num){
      var s='';
      if(num>=100){ s+=ones[Math.floor(num/100)]+' hundred'; num%=100; if(num)s+=' '; }
      if(num>=20){ s+=tens[Math.floor(num/10)]; if(num%10)s+='-'+ones[num%10]; }
      else if(num>0){ s+=ones[num]; }
      return s;
    }
    if(n===0) return 'zero';
    var partes=[]; var escalas=['','thousand','million','billion']; var i=0;
    while(n>0){
      var tres=n%1000;
      if(tres) partes.unshift(tresCifras(tres)+(escalas[i]?' '+escalas[i]:''));
      n=Math.floor(n/1000); i++;
    }
    return partes.join(' ');
  }

  // ============================================================
  // PREVIEW (modal HTML)
  // ============================================================
  var _facturaPreviewData = null;   // datos calculados
  var _facturaVenta = null;         // venta original

  window.abrirPreviewFactura = function(ventaId){
    var venta = (C.ventas||[]).find(function(x){return x.id===ventaId;});
    if(!venta){ toast('Venta no encontrada','error'); return; }
    _facturaVenta = venta;
    var d = datosDesdeVenta(venta);
    _facturaPreviewData = d;

    // Número: si la venta ya tiene numero_factura y parece de este sistema, respetarlo;
    // si no, mostrar el PRÓXIMO correlativo.
    var numeroMostrar = (venta.numero_factura && /\d/.test(venta.numero_factura))
      ? venta.numero_factura
      : proximoNumeroStr();
    var yaNumerada = !!(venta.numero_factura && /\d/.test(venta.numero_factura));

    var c = d.cliente;
    var hoyStr = (function(){var t=new Date();return t.getDate()+'-'+['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][t.getMonth()]+'-'+t.getFullYear();})();

    var filas = d.items.map(function(it){
      return '<tr>'+
        '<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;text-align:center">-</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">'+escapeHtml(it.desc)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">'+it.qty+' '+(it.qty===1?'unit':'units')+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">'+fmtN(it.unit)+'</td>'+
        '<td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">'+fmtN(it.amount)+'</td>'+
      '</tr>';
    }).join('');

    var html =
      '<div style="background:var(--bg2);border:1px solid var(--cyan);border-radius:12px;max-width:860px;width:100%;max-height:94vh;overflow-y:auto;box-shadow:var(--shadow-lg)">'+
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg2);z-index:5">'+
        '<h3 style="font-size:15px;font-weight:600">🧾 Vista previa de factura</h3>'+
        '<button class="rlbtn" onclick="cerrarPreviewFactura()" style="font-size:20px">✕</button>'+
      '</div>'+
      '<div style="padding:20px">'+

      // Aviso numeración
      (yaNumerada
        ? '<div class="alert ainfo" style="margin-bottom:14px">Esta venta ya tiene el número <b>'+escapeHtml(numeroMostrar)+'</b>. Se reutilizará (no consume un nuevo correlativo).</div>'
        : '<div class="alert ainfo" style="margin-bottom:14px">Se asignará el próximo número correlativo: <b>'+escapeHtml(numeroMostrar)+'</b>. Al confirmar, se guarda en la venta y avanza el contador.</div>')+

      // ---- Hoja de factura (fondo blanco, como el PDF) ----
      '<div id="facturaHoja" style="background:#ffffff;color:#1f2937;border-radius:8px;padding:26px 30px;font-size:12px;line-height:1.5">'+

        // Encabezado
        '<div style="display:flex;align-items:center;gap:16px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px">'+
          '<img src="'+(window.LOGO_LEEX||'')+'" alt="LEEX" style="width:150px;height:auto"/>'+
          '<div style="font-size:22px;font-weight:700;letter-spacing:1px;color:#111;margin-left:auto">COMMERCIAL INVOICE</div>'+
        '</div>'+

        // Bloque To / Deliver to
        '<div style="display:flex;gap:30px;margin-bottom:16px">'+
          '<div style="flex:1">'+
            campo('To', c.nombre_empresa||c.dato_fiscal||'—')+
            campo('Address', direccionCliente(c))+
            campo('Tel', c.telefono||'—')+
            campo('NIF / RUT', c.cuit_rut_taxid||'—')+
            campo('E-mail', c.email||'—')+
            campo('From', EMISOR.from)+
            campo('Payment terms', c.condicion_pago||'—')+
          '</div>'+
          '<div style="flex:1">'+
            campo('Deliver to', c.nombre_empresa||c.dato_fiscal||'—')+
            campo('Address', direccionCliente(c))+
            campo('Tel', c.telefono||'—')+
            campo('Attn', c.referente||'—')+
            campo('Invoice No.', numeroMostrar)+
            campo('Date', hoyStr)+
          '</div>'+
        '</div>'+

        // Tabla de bienes
        '<table style="width:100%;border-collapse:collapse;border:1px solid #111;margin-bottom:10px">'+
          '<thead><tr style="background:#f3f4f6">'+
            '<th style="padding:6px 8px;border-bottom:1px solid #111;text-align:center;font-weight:700">Marks</th>'+
            '<th style="padding:6px 8px;border-bottom:1px solid #111;text-align:left;font-weight:700">Description of Goods</th>'+
            '<th style="padding:6px 8px;border-bottom:1px solid #111;text-align:center;font-weight:700">Quantities</th>'+
            '<th style="padding:6px 8px;border-bottom:1px solid #111;text-align:right;font-weight:700">Unit Price(USD)</th>'+
            '<th style="padding:6px 8px;border-bottom:1px solid #111;text-align:right;font-weight:700">Amount(USD)</th>'+
          '</tr></thead>'+
          '<tbody>'+filas+'</tbody>'+
        '</table>'+

        // Total
        '<div style="display:flex;justify-content:flex-end;margin-bottom:10px">'+
          '<div style="font-weight:700;font-size:13px">Total EXW (USD):&nbsp;&nbsp;'+fmtN(d.total)+'</div>'+
        '</div>'+
        '<div style="font-weight:700;margin-bottom:20px">TOTAL AMOUNT: U.S dollars '+numeroEnPalabras(d.total)+'.</div>'+

        // Pie emisor
        '<div style="border-top:1px solid #d1d5db;padding-top:10px;color:#374151">'+
          '<div style="font-weight:700">'+EMISOR.nombre+'</div>'+
          '<div>Tel: '+EMISOR.tel+'</div>'+
          '<div>Web: '+EMISOR.web+'</div>'+
          '<div>Add: '+EMISOR.direccion+'</div>'+
        '</div>'+

        // Leyenda datos bancarios
        '<div style="border-top:1px solid #d1d5db;margin-top:14px;padding-top:10px;color:#374151;font-size:11px">'+
          '<div style="font-weight:700;margin-bottom:4px;color:#111">Bank details</div>'+
          '<div>Cuenta bancaria o IBAN N°: '+BANCO.cuenta+'</div>'+
          '<div>Denominación: '+BANCO.denominacion+'</div>'+
          '<div>Domicilio: '+BANCO.domicilio+'</div>'+
          '<div>Ciudad: '+BANCO.ciudad+'</div>'+
          '<div>País: '+BANCO.pais+'</div>'+
          '<div>Código SWIFT: '+BANCO.swift+'</div>'+
          '<div>Nombre del Banco: '+BANCO.banco+'</div>'+
        '</div>'+

      '</div>'+  // fin facturaHoja

      // Acciones
      '<div class="factions" style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">'+
        '<button class="btn bp" onclick="confirmarEmisionFactura('+ (yaNumerada?'false':'true') +')">✅ Confirmar y descargar PDF</button>'+
        '<button class="btn bv" onclick="confirmarEmisionFacturaExcel('+ (yaNumerada?'false':'true') +')">📊 Confirmar y descargar Excel</button>'+
        '<button class="btn bs" onclick="cerrarPreviewFactura()">Cancelar</button>'+
      '</div>'+

      '</div></div>';

    var modal = document.getElementById('modalFactura');
    if(!modal){
      modal = document.createElement('div');
      modal.id = 'modalFactura';
      modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2000;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
      document.body.appendChild(modal);
    }
    modal.innerHTML = html;
    modal.style.display = 'flex';
  };

  function campo(label, valor){
    return '<div style="display:flex;margin-bottom:2px"><div style="min-width:96px;font-weight:700;color:#111">'+label+':</div><div style="flex:1">'+escapeHtml(valor||'—')+'</div></div>';
  }
  function direccionCliente(c){
    var partes=[c.direccion, c.ciudad, c.pais].filter(Boolean);
    return partes.join(', ') || '—';
  }

  window.cerrarPreviewFactura = function(){
    var m = document.getElementById('modalFactura');
    if(m){ m.style.display='none'; m.innerHTML=''; }
    _facturaPreviewData=null; _facturaVenta=null;
  };

  // ============================================================
  // Confirmar emisión → consume número (si aplica), guarda en venta, exporta
  // ============================================================
  function resolverNumero(consume){
    // Devuelve Promise<string> con el número final
    if(!consume){
      // reutilizar el ya existente
      return Promise.resolve(_facturaVenta.numero_factura);
    }
    return consumirNumero().then(function(r){
      // guardar en la venta
      return sbPatchWhere('ventas','id',_facturaVenta.id,{numero_factura:r.str}).then(function(){
        _facturaVenta.numero_factura = r.str;
        // reflejar en cache local
        var v=(C.ventas||[]).find(function(x){return x.id===_facturaVenta.id;});
        if(v)v.numero_factura=r.str;
        return r.str;
      });
    });
  }

  window.confirmarEmisionFactura = function(consume){
    resolverNumero(consume).then(function(numero){
      generarPDF(_facturaPreviewData, numero);
      toast('Factura '+numero+' emitida (PDF)','success');
      cerrarPreviewFactura();
      if(typeof reload==='function') reload('clientes');
    }).catch(function(e){ toast('Error al emitir: '+e,'error'); });
  };

  window.confirmarEmisionFacturaExcel = function(consume){
    resolverNumero(consume).then(function(numero){
      generarExcel(_facturaPreviewData, numero);
      toast('Factura '+numero+' emitida (Excel)','success');
      cerrarPreviewFactura();
      if(typeof reload==='function') reload('clientes');
    }).catch(function(e){ toast('Error al emitir: '+e,'error'); });
  };

  // ============================================================
  // PDF (jsPDF)
  // ============================================================
  function generarPDF(d, numero){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('No se pudo cargar jsPDF','error'); return; }
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({unit:'pt', format:'a4'});
    var W = doc.internal.pageSize.getWidth();
    var M = 40;              // margen
    var x = M, y = 50;
    var c = d.cliente;
    var hoyStr = (function(){var t=new Date();return t.getDate()+'-'+['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][t.getMonth()]+'-'+t.getFullYear();})();

    // --- Logo LEEX (imagen embebida) ---
    var logoW = 150, logoH = 56;
    var logoSrc = window.LOGO_LEEX_PDF || window.LOGO_LEEX;
    if(logoSrc){
      try { doc.addImage(logoSrc, 'PNG', x, y-8, logoW, logoH); } catch(e){}
    }
    // Título
    doc.setTextColor(17,17,17); doc.setFont('helvetica','bold');
    doc.setFontSize(20);
    doc.text('COMMERCIAL INVOICE', W-M, y+22, {align:'right'});
    y += 44;
    doc.setDrawColor(17,17,17); doc.setLineWidth(1.5); doc.line(M, y, W-M, y);
    y += 20;

    // --- Bloques To / Deliver to ---
    doc.setFontSize(9); doc.setTextColor(31,41,55);
    var colL = M, colR = W/2 + 10, startY = y;
    y = bloqueCampos(doc, colL, startY, [
      ['To', c.nombre_empresa||c.dato_fiscal||'—'],
      ['Address', direccionCliente(c)],
      ['Tel', c.telefono||'—'],
      ['NIF / RUT', c.cuit_rut_taxid||'—'],
      ['E-mail', c.email||'—'],
      ['From', EMISOR.from],
      ['Payment terms', c.condicion_pago||'—']
    ], (W/2-M-14));
    var yR = bloqueCampos(doc, colR, startY, [
      ['Deliver to', c.nombre_empresa||c.dato_fiscal||'—'],
      ['Address', direccionCliente(c)],
      ['Tel', c.telefono||'—'],
      ['Attn', c.referente||'—'],
      ['Invoice No.', numero],
      ['Date', hoyStr]
    ], (W/2-M-14));
    y = Math.max(y, yR) + 14;

    // --- Tabla ---
    var cols = [
      {t:'Marks', w:50, a:'center'},
      {t:'Description of Goods', w:W-2*M-50-70-90-90, a:'left'},
      {t:'Quantities', w:70, a:'center'},
      {t:'Unit Price(USD)', w:90, a:'right'},
      {t:'Amount(USD)', w:90, a:'right'}
    ];
    // header
    doc.setFillColor(243,244,246); doc.setDrawColor(17,17,17); doc.setLineWidth(0.8);
    var rowH = 18, cx = M;
    doc.rect(M, y, W-2*M, rowH, 'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(17,17,17);
    cols.forEach(function(col){
      var tx = col.a==='right'? cx+col.w-4 : (col.a==='center'? cx+col.w/2 : cx+4);
      doc.text(col.t, tx, y+12, {align: col.a});
      cx += col.w;
    });
    y += rowH;

    // filas (con wrap en descripción)
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    d.items.forEach(function(it){
      var descLines = doc.splitTextToSize(it.desc, cols[1].w-8);
      var h = Math.max(rowH, descLines.length*11 + 6);
      cx = M;
      var vals = ['-', descLines, it.qty+' '+(it.qty===1?'unit':'units'), fmtN(it.unit), fmtN(it.amount)];
      cols.forEach(function(col,i){
        doc.rect(cx, y, col.w, h);
        var tx = col.a==='right'? cx+col.w-4 : (col.a==='center'? cx+col.w/2 : cx+4);
        if(i===1){ doc.text(descLines, cx+4, y+12); }
        else { doc.text(String(vals[i]), tx, y+12, {align: col.a}); }
        cx += col.w;
      });
      y += h;
    });

    // --- Total ---
    y += 14;
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Total EXW (USD):  '+fmtN(d.total), W-M, y, {align:'right'});
    y += 18;
    doc.setFontSize(9);
    var totLines = doc.splitTextToSize('TOTAL AMOUNT: U.S dollars '+numeroEnPalabras(d.total)+'.', W-2*M);
    doc.text(totLines, M, y);
    y += totLines.length*12 + 20;

    // --- Pie emisor ---
    doc.setDrawColor(209,213,219); doc.setLineWidth(0.5); doc.line(M, y, W-M, y); y += 14;
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(55,65,81);
    doc.text(EMISOR.nombre, M, y); y+=12;
    doc.setFont('helvetica','normal');
    doc.text('Tel: '+EMISOR.tel, M, y); y+=12;
    doc.text('Web: '+EMISOR.web, M, y); y+=12;
    doc.text('Add: '+EMISOR.direccion, M, y);

    // --- Leyenda datos bancarios ---
    y += 18;
    doc.setDrawColor(209,213,219); doc.setLineWidth(0.5); doc.line(M, y, W-M, y); y += 14;
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(17,17,17);
    doc.text('Bank details', M, y); y += 13;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(55,65,81);
    var lineasBanco = [
      'Cuenta bancaria o IBAN N°: '+BANCO.cuenta,
      'Denominación: '+BANCO.denominacion,
      'Domicilio: '+BANCO.domicilio,
      'Ciudad: '+BANCO.ciudad,
      'País: '+BANCO.pais,
      'Código SWIFT: '+BANCO.swift,
      'Nombre del Banco: '+BANCO.banco
    ];
    lineasBanco.forEach(function(l){ doc.text(l, M, y); y += 11; });

    doc.save('Factura_'+numero.replace(/[^\w\-]/g,'_')+'.pdf');
  }

  function bloqueCampos(doc, x, y, campos, maxW){
    var labelW = 78;
    campos.forEach(function(p){
      doc.setFont('helvetica','bold'); doc.setTextColor(17,17,17);
      doc.text(p[0]+':', x, y);
      doc.setFont('helvetica','normal'); doc.setTextColor(31,41,55);
      var lines = doc.splitTextToSize(String(p[1]||'—'), maxW-labelW);
      doc.text(lines, x+labelW, y);
      y += Math.max(12, lines.length*11);
    });
    return y;
  }

  // ============================================================
  // Excel (SheetJS)
  // ============================================================
  function generarExcel(d, numero){
    if(!window.XLSX){ toast('No se pudo cargar XLSX','error'); return; }
    var c = d.cliente;
    var hoyStr = (function(){var t=new Date();return t.getDate()+'-'+['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][t.getMonth()]+'-'+t.getFullYear();})();

    var aoa = [];
    aoa.push(['LEEX LLC', '', '', 'COMMERCIAL INVOICE', '']);
    aoa.push([]);
    aoa.push(['To:', c.nombre_empresa||c.dato_fiscal||'', '', 'Deliver to:', c.nombre_empresa||c.dato_fiscal||'']);
    aoa.push(['Address:', direccionCliente(c), '', 'Address:', direccionCliente(c)]);
    aoa.push(['Tel:', c.telefono||'', '', 'Tel:', c.telefono||'']);
    aoa.push(['NIF / RUT:', c.cuit_rut_taxid||'', '', 'Attn:', c.referente||'']);
    aoa.push(['E-mail:', c.email||'', '', 'Invoice No.:', numero]);
    aoa.push(['From:', EMISOR.from, '', 'Date:', hoyStr]);
    aoa.push(['Payment terms:', c.condicion_pago||'', '', '', '']);
    aoa.push([]);
    aoa.push(['Marks','Description of Goods','Quantities','Unit Price(USD)','Amount(USD)']);
    d.items.forEach(function(it){
      aoa.push(['-', it.desc, it.qty+' '+(it.qty===1?'unit':'units'), round2(it.unit), round2(it.amount)]);
    });
    aoa.push([]);
    aoa.push(['','','','Total EXW (USD)', round2(d.total)]);
    aoa.push([]);
    aoa.push(['TOTAL AMOUNT: U.S dollars '+numeroEnPalabras(d.total)+'.']);
    aoa.push([]);
    aoa.push([EMISOR.nombre]);
    aoa.push(['Tel: '+EMISOR.tel]);
    aoa.push(['Web: '+EMISOR.web]);
    aoa.push(['Add: '+EMISOR.direccion]);
    aoa.push([]);
    aoa.push(['Bank details']);
    aoa.push(['Cuenta bancaria o IBAN N°: '+BANCO.cuenta]);
    aoa.push(['Denominación: '+BANCO.denominacion]);
    aoa.push(['Domicilio: '+BANCO.domicilio]);
    aoa.push(['Ciudad: '+BANCO.ciudad]);
    aoa.push(['País: '+BANCO.pais]);
    aoa.push(['Código SWIFT: '+BANCO.swift]);
    aoa.push(['Nombre del Banco: '+BANCO.banco]);

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{wch:16},{wch:44},{wch:14},{wch:16},{wch:16}];
    // merge del título
    ws['!merges'] = [{s:{r:0,c:3},e:{r:0,c:4}}];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Invoice');
    XLSX.writeFile(wb, 'Factura_'+numero.replace(/[^\w\-]/g,'_')+'.xlsx');
  }
  function round2(n){ return Math.round((parseFloat(n)||0)*100)/100; }

  // ============================================================
  // Guardado de la config de numeración (desde la página Configuración)
  // ============================================================
  window.guardarConfigFactura = function(){
    var prefijo = (document.getElementById('cfgFacPrefijo')||{}).value || '';
    var actualEl = document.getElementById('cfgFacActual');
    var relleno  = (document.getElementById('cfgFacRelleno')||{}).value || '6';
    var sufijo   = (document.getElementById('cfgFacSufijo')||{}).value || '';
    var actual   = actualEl ? actualEl.value : '';

    if(actual==='' || isNaN(parseInt(actual,10))){ toast('Ingresá el último número emitido (o 0 si arrancás de cero)','error'); return; }

    Promise.all([
      upsertCfg('factura_prefijo', prefijo),
      upsertCfg('factura_numero_actual', parseInt(actual,10)),
      upsertCfg('factura_relleno', parseInt(relleno,10)||6),
      upsertCfg('factura_sufijo_serie', sufijo)
    ]).then(function(){
      if(typeof C!=="undefined" && C.config){
        C.config.factura_prefijo = prefijo;
        C.config.factura_numero_actual = parseInt(actual,10);
        C.config.factura_relleno = parseInt(relleno,10)||6;
        C.config.factura_sufijo_serie = sufijo;
      }
      toast('Numeración de facturas guardada · próxima: '+proximoNumeroStr(),'success');
      if(typeof reload==='function') reload('config');
    }).catch(function(e){ toast('Error: '+e,'error'); });
  };

  // Panel HTML para inyectar en la página Configuración
  window.panelConfigFactura = function(readonly){
    var f = cfgFactura();
    var prox = proximoNumeroStr();
    if(readonly){
      return '<div class="panel"><h3>🧾 Numeración de Facturas</h3>'+
        '<div style="font-size:12px;color:var(--text2)">Próximo número: <b style="color:var(--cyan)">'+escapeHtml(prox)+'</b></div>'+
        '<div style="font-size:11px;color:var(--text2);margin-top:6px">Solo administradores pueden modificar la numeración.</div></div>';
    }
    return '<div class="panel"><h3>🧾 Numeración de Facturas</h3>'+
      '<div style="font-size:11px;color:var(--text2);margin-bottom:10px">El próximo número se arma como <code>Prefijo + Número(con ceros) + Sufijo</code>. Cargá el <b>último número emitido</b> para que las próximas sean correlativas.</div>'+
      '<div class="fg2" style="margin-bottom:10px">'+
        '<div class="f"><label>Prefijo</label><input type="text" id="cfgFacPrefijo" value="'+escapeHtml(f.prefijo)+'" placeholder="LEEX-CI-"/></div>'+
        '<div class="f"><label>Sufijo / Serie</label><input type="text" id="cfgFacSufijo" value="'+escapeHtml(f.sufijo)+'" placeholder="-001"/></div>'+
      '</div>'+
      '<div class="fg2" style="margin-bottom:10px">'+
        '<div class="f"><label>Último número emitido</label><input type="number" id="cfgFacActual" value="'+(isNaN(f.actual)?0:f.actual)+'" min="0" step="1"/></div>'+
        '<div class="f"><label>Dígitos (ceros a la izq.)</label><input type="number" id="cfgFacRelleno" value="'+(isNaN(f.relleno)?6:f.relleno)+'" min="1" max="12" step="1"/></div>'+
      '</div>'+
      '<div style="font-size:11px;color:var(--text2);margin-bottom:10px">Próximo a emitir: <b style="color:var(--cyan)">'+escapeHtml(prox)+'</b></div>'+
      '<div class="factions"><button class="btn bp sm" onclick="guardarConfigFactura()">Guardar numeración</button></div>'+
    '</div>';
  };

  // exponer helpers por si se necesitan externamente
  window.FacturaLeex = {
    proximoNumeroStr: proximoNumeroStr,
    datosDesdeVenta: datosDesdeVenta
  };

})();
