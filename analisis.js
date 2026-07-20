/* =====================================================================
   DEAM SRL · Informes Gerenciales — Sección Análisis
   Recolecta los datos de los cinco informes, los arma en un contexto de
   texto compacto y lo envía a /api/analizar, que consulta a Claude con el
   prompt de analista financiero y devuelve el reporte.
   ===================================================================== */

const AN = { loading:false, reporte:null, generado:null, error:null };

/* ---------- Helpers de formato para el contexto ---------- */
const anUSD = v => (v==null||!isFinite(v)) ? 's/d' : 'US$ '+Math.round(v).toLocaleString('es-AR');
const anARS = v => (v==null||!isFinite(v)) ? 's/d' : '$ '+Math.round(v).toLocaleString('es-AR');
const anNum = (v,d=2) => (v==null||!isFinite(v)) ? 's/d' : v.toFixed(d).replace('.',',');
const anPct = v => (v==null||!isFinite(v)) ? 's/d' : (v*100).toFixed(1).replace('.',',')+'%';

/* =====================================================================
   RECOLECCIÓN POR INFORME
   ===================================================================== */

/* 1 · Capital de Trabajo: último cierre + variación y los indicadores */
function anCapital(){
  if(typeof cierresFull==='undefined' || !cierresFull.length) return '(sin datos cargados)';
  const mens = cierresFull.filter(c=>c.tipo==='mensual').sort((a,b)=>a.fecha.localeCompare(b.fecha));
  if(!mens.length) return '(sin cierres mensuales)';
  const c = mens[mens.length-1];
  const prev = mens.length>1 ? mens[mens.length-2] : null;
  const t = c.totals || (typeof totalsFromLineas==='function' ? totalsFromLineas(c.lineas||[]) : null);
  if(!t) return '(sin totales)';

  let s = `Último cierre: ${c.fecha} (TC $${c.tc})\n`;
  // detalle de rubros, que es donde se ve el peso de los cheques
  (c.lineas||[]).forEach(l=>{
    if(+l.monto_usd) s += `  - ${l.rubro} (${l.categoria}): ${anUSD(l.monto_usd)}\n`;
  });
  s += `TOTALES: Activo Cte ${anUSD(t.actCte)} | Stock ${anUSD(t.stock)} | Activo ${anUSD(t.activo)} | Pasivo ${anUSD(t.pasivo)} | PN ${anUSD(t.pn)}\n`;
  if(t.disponible!=null) s += `Disponible líquido (caja+bancos+cheques): ${anUSD(t.disponible)}\n`;
  if(prev && prev.totals){
    const v=(a,b)=> b? ((a-b)/Math.abs(b)*100).toFixed(1).replace('.',',')+'%' : 's/d';
    s += `Variación vs ${prev.fecha}: Activo ${v(t.activo,prev.totals.activo)} | Pasivo ${v(t.pasivo,prev.totals.pasivo)} | PN ${v(t.pn,prev.totals.pn)}\n`;
  }
  if(typeof INDICADORES!=='undefined'){
    s += `Indicadores:\n`;
    INDICADORES.forEach(ind=>{
      const val = ind.calc({totals:t});
      const st = ind.status(val);
      const txt = st==='ok'?'Bien':st==='warn'?'Alerta':'Urgente';
      s += `  - ${ind.name} (${ind.formula}): ${anNum(val)} → ${txt}\n`;
    });
  }
  return s;
}

/* 2 · Punto de Equilibrio: serie de los últimos meses */
function anEquilibrio(){
  if(typeof equilibrio==='undefined' || !equilibrio.length) return '(sin datos cargados)';
  const rows = equilibrio.slice().sort((a,b)=>a.fecha.localeCompare(b.fecha)).slice(-6);
  let s = 'Últimos períodos (en USD):\n';
  rows.forEach(r=>{
    const k = (typeof beCalc==='function') ? beCalc(r) : null;
    const rev = (typeof revIsFecha==='function' && revIsFecha(r.fecha)) ? ' [EN REVISIÓN]' : '';
    if(k) s += `  - ${r.fecha}${rev}: Ventas ${anUSD(k.vUsd)} | Costo var ${anUSD(k.cvUsd)} | Costo fijo ${anUSD(k.cfUsd)} | Margen contrib ${anPct(k.mc)} | Punto equilibrio ${anUSD(k.peUsd)} | Margen seguridad ${anPct(k.ms)}\n`;
  });
  return s;
}

/* 3 · Informe de Gestión: resultado por período y acumulado */
function anGestion(){
  if(typeof gPeriodos==='undefined' || !gPeriodos.length) return '(sin datos cargados)';
  const ps = gPeriodos.slice().sort((a,b)=>(a.fecha||'').localeCompare(b.fecha||''));
  let s = 'Resultado por período (ARS):\n';
  const claves = ['ventas','cmv','utilidad_bruta','total_gastos','utilidad_neta'];
  ps.slice(-6).forEach(p=>{
    const f = (typeof gComputar==='function') ? gComputar(p.valores||{}) : {};
    const rev = (typeof revIsFecha==='function' && revIsFecha(p.fecha)) ? ' [EN REVISIÓN]' : '';
    const ventas = (typeof catSigned==='function') ? catSigned('ventas', p.valores||{}) : null;
    s += `  - ${p.etiqueta||p.fecha}${rev}: Ventas ${anARS(ventas)}`;
    if(f.utilidad_bruta!=null) s += ` | Utilidad Bruta ${anARS(f.utilidad_bruta)}`;
    if(f.utilidad_neta!=null)  s += ` | Utilidad Neta ${anARS(f.utilidad_neta)}`;
    if(f.resultado_despues!=null) s += ` | Resultado desp. imp. ${anARS(f.resultado_despues)}`;
    s += '\n';
  });
  // desglose de la última para dar detalle de estructura de costos
  const last = ps[ps.length-1];
  if(last && typeof G_CATEGORIAS!=='undefined' && typeof catSigned==='function'){
    s += `Desglose del último período (${last.etiqueta||last.fecha}):\n`;
    G_CATEGORIAS.forEach(cat=>{
      const v = catSigned(cat.key, last.valores||{});
      if(v) s += `  - ${cat.label}: ${anARS(v)}\n`;
    });
  }
  return s;
}

/* 4 · Proyección: flujo de caja de los 12 meses */
function anProyeccion(){
  if(typeof pyComputeAll!=='function') return '(módulo no disponible)';
  let cols;
  try{ cols = pyComputeAll().cols; }catch(e){ return '(sin datos)'; }
  if(!cols || !cols.length) return '(sin datos cargados)';
  let s = 'Flujo de caja proyectado (12 meses, ARS):\n';
  cols.forEach((c,i)=>{
    const et = (typeof pyMeses!=='undefined' && pyMeses[i]) ? pyMeses[i] : `Mes ${i+1}`;
    s += `  - ${et}: Ingresos ${anARS(c.total_ing)} | Egresos ${anARS(c.total_egr)} | Diferencia ${anARS(c.diferencia)} | Saldo acumulado ${anARS(c.saldo_acum)}\n`;
  });
  if(typeof pyCfg!=='undefined'){
    s += `Parámetros: dólar inicial $${pyCfg.dolar_inicial} | aumento mensual ${anPct(pyCfg.aumento_dolar)} | IVA ${anPct(pyCfg.iva)} | costo s/venta ${anPct(pyCfg.pct_costo)}\n`;
  }
  if(typeof pyUpdatedAt!=='undefined' && pyUpdatedAt){
    s += `Última actualización de la proyección: ${pyFmtUpdated(pyUpdatedAt)}\n`;
  }
  return s;
}

/* 5 · Presupuesto: ejecutado vs referencia */
function anPresupuesto(){
  if(typeof PR==='undefined' || !PR.loaded || !PR.categories.length) return '(sin datos cargados)';
  const fyCur = PR.fiscalYears.find(f=>!f.is_reference);
  const fyRef = PR.fiscalYears.find(f=>f.is_reference);
  if(!fyCur) return '(sin ejercicio actual)';
  let s = `Ejercicio actual: ${fyCur.name}`;
  if(fyRef) s += ` | Referencia: ${fyRef.name}`;
  s += '\n';

  // hasta qué mes hay datos
  const mc = (typeof prMonthsOf==='function') ? prMonthsOf(fyCur.id) : [];
  const conDatos = mc.filter(m=>PR.values.some(v=>v.month_id===m.id));
  const ultimo = conDatos.length ? conDatos[conDatos.length-1].order_index : 0;
  if(!ultimo) return s+'(sin valores cargados en el ejercicio actual)';
  s += `Acumulado hasta el mes ${ultimo} del ejercicio:\n`;

  const claves = ['Total de Ventas','Subtotal 1','Utilidad Bruta','Subtotal 3','Total de Utilidad Neta','Resultado después del impuesto'];
  claves.forEach(name=>{
    if(typeof prValAccum!=='function') return;
    const act = prValAccum(fyCur.id, name, ultimo);
    let linea = `  - ${name}: ${anARS(act)}`;
    if(fyRef && typeof prRefAcumVal==='function'){
      const ref = prRefAcumVal(name);
      if(ref) linea += ` | referencia anual ${anARS(ref)} (prom. mensual ${anARS(ref/12)})`;
    }
    s += linea+'\n';
  });

  // meses en revisión dentro del ejercicio
  if(typeof revIsUnderReview==='function'){
    const revs = mc.filter(m=>revIsUnderReview(m.calendar_year,m.month_number))
                   .map(m=>`${m.month_name} ${m.calendar_year}`);
    if(revs.length) s += `Meses marcados EN REVISIÓN (provisorios): ${revs.join(', ')}\n`;
  }
  return s;
}

/* =====================================================================
   ARMADO DEL CONTEXTO COMPLETO
   ===================================================================== */
function anBuildContexto(){
  const hoy = new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'long',year:'numeric'});
  return `FECHA DEL ANÁLISIS: ${hoy}

===== 1. CAPITAL DE TRABAJO =====
${anCapital()}

===== 2. PUNTO DE EQUILIBRIO =====
${anEquilibrio()}

===== 3. INFORME DE GESTIÓN (Estado de Resultados) =====
${anGestion()}

===== 4. PROYECCIÓN DE FLUJO DE CAJA =====
${anProyeccion()}

===== 5. PRESUPUESTO =====
${anPresupuesto()}`;
}

/* =====================================================================
   LLAMADA AL ENDPOINT Y RENDER
   ===================================================================== */
async function anAnalizar(){
  if(AN.loading) return;
  AN.loading=true; AN.error=null; renderAnalisis();
  try{
    const contexto = anBuildContexto();
    const r = await fetch('/api/analizar', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({contexto}),
    });
    const data = await r.json();
    if(!r.ok) throw new Error(data.error||`Error ${r.status}`);
    AN.reporte = data.reporte;
    AN.generado = data.generado;
  }catch(e){
    AN.error = e.message||String(e);
  }
  AN.loading=false;
  renderAnalisis();
}

/* Markdown mínimo → HTML (títulos, negritas, listas y párrafos) */
function anMd(md){
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = esc(md).split('\n');
  let html='', inList=false;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\*(.+?)\*/g,'<i>$1</i>');
  for(let raw of lines){
    const l = raw.trim();
    if(!l){ if(inList){html+='</ul>';inList=false;} continue; }
    if(/^#{2,3}\s/.test(l)){
      if(inList){html+='</ul>';inList=false;}
      html += `<h3 class="an-h">${inline(l.replace(/^#{2,3}\s*/,''))}</h3>`;
    } else if(/^[-*]\s/.test(l)){
      if(!inList){html+='<ul class="an-ul">';inList=true;}
      html += `<li>${inline(l.replace(/^[-*]\s*/,''))}</li>`;
    } else {
      if(inList){html+='</ul>';inList=false;}
      html += `<p>${inline(l)}</p>`;
    }
  }
  if(inList) html+='</ul>';
  return html;
}

function renderAnalisis(){
  const host=document.getElementById('an-host'); if(!host) return;
  const sub=document.getElementById('an-sub');
  if(sub) sub.textContent = AN.generado
    ? 'Reporte generado el '+new Date(AN.generado).toLocaleString('es-AR')
    : 'Reporte financiero de corto y mediano plazo';

  if(AN.loading){
    host.innerHTML = `<div class="panel"><div class="placeholder">
      <div class="an-spinner"></div>
      <h2>Analizando los informes…</h2>
      <p>Se están leyendo Capital de Trabajo, Punto de Equilibrio, Gestión, Proyección y Presupuesto.</p></div></div>`;
    return;
  }
  if(AN.error){
    host.innerHTML = `<div class="panel"><div class="placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
      <h2>No se pudo generar el análisis</h2><p>${AN.error}</p>
      <button class="btn" style="margin-top:14px" onclick="anAnalizar()">Reintentar</button></div></div>`;
    return;
  }
  if(!AN.reporte){
    host.innerHTML = `<div class="panel"><div class="placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <h2>Análisis financiero</h2>
      <p>Lee los cinco informes y genera un reporte con la situación actual, señales de corto y mediano plazo, y recomendaciones accionables.</p>
      <button class="btn" style="margin-top:16px" onclick="anAnalizar()">Analizar</button></div></div>`;
    return;
  }
  host.innerHTML = `
    <div class="controls no-print">
      <div class="cp-spacer"></div>
      <button class="btn gray" onclick="anAnalizar()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 8a8 8 0 0 0-14-3M4 16a8 8 0 0 0 14 3"/></svg>Volver a analizar</button>
      <button class="btn gray" onclick="printReport()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 9V2h12v7M6 18H4v-6h16v6h-2M8 14h8v8H8z"/></svg>PDF</button>
    </div>
    <div class="panel an-panel">${anMd(AN.reporte)}</div>`;
}

window.anAnalizar=anAnalizar; window.renderAnalisis=renderAnalisis;
