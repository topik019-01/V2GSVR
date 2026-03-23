const SUPABASE_URL = 'https://pnaobmyaugbccfwwhyob.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuYW9ibXlhdWdiY2Nmd3doeW9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzQwMzcsImV4cCI6MjA4MzkxMDAzN30.-TwJWOKZWXNDq2u789-dRcX--yA4fWjGSgHc-Zr-ny4';

// Mapa con Estilo Voyager (Claro)
const map = L.map('map').setView([-1.6635, -78.6547], 13);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// Grupos de capas
let perimetroLayerGroup = L.layerGroup();
let reportesLayerGroup = L.layerGroup();
let heatmapLayer = null;
let tempMarker = null;

let allReportesData = [];
let urbanPolygons = []; 

let chartInstanceType = null;
let chartInstanceTime = null;

// -------------------------------------------------------------
// FUNCIONES UI
// -------------------------------------------------------------
function togglePanel() {
    const panel = document.getElementById('mainPanel');
    const toggle = document.getElementById('panelToggle');
    panel.classList.toggle('open');
    toggle.textContent = panel.classList.contains('open') ? '✕' : '☰';
}

function toggleDashboard() {
    const modal = document.getElementById('dashboardModal');
    if (modal.style.display !== 'flex') {
        actualizarDashboard();
        modal.style.display = 'flex';
    } else {
        modal.style.display = 'none';
    }
}

function mostrarEstadoForm(mensaje, tipo) {
    const status = document.getElementById('formStatus');
    status.textContent = mensaje;
    status.className = `form-status ${tipo}`;
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 3000);
}

function normalizarTexto(texto) {
    if (!texto) return 'No especificado';
    let limpio = texto.toString().toLowerCase().replace(/_/g, ' ').normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

function encontrarFecha(item) {
    if (item.date && typeof item.date === 'string' && item.date.length >= 10) {
        const parts = item.date.split('-');
        return new Date(parts[0], parts[1] - 1, parts[2]); 
    }
    const fechaFallback = item.fecha_reporte || item.fecha || item.created_at;
    if (fechaFallback) {
        let fecha = new Date(fechaFallback);
        if (!isNaN(fecha)) {
            fecha.setTime(fecha.getTime() - (5 * 60 * 60 * 1000)); 
            return fecha;
        }
    }
    return null;
}

function encontrarTipo(item) {
    return item.sv || item.tipo_reporte || item.tipo_incidente || item.tipo || 'Colisión Vehicular';
}

// -------------------------------------------------------------
// VALIDACIÓN GEOGRÁFICA
// -------------------------------------------------------------
function isPointInPolygon(point, vs) {
    var x = point[0], y = point[1];
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        var xi = vs[i][0], yi = vs[i][1];
        var xj = vs[j][0], yj = vs[j][1];
        var intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function validarUbicacionUrbana(lat, lng) {
    if (urbanPolygons.length === 0) return true; 
    const punto = [lng, lat]; 
    let estaDentro = false;
    for (let geojson of urbanPolygons) {
        if (geojson.type === 'Polygon') {
            if (isPointInPolygon(punto, geojson.coordinates[0])) { estaDentro = true; break; }
        } else if (geojson.type === 'MultiPolygon') {
            for (let polyCoords of geojson.coordinates) {
                if (isPointInPolygon(punto, polyCoords[0])) { estaDentro = true; break; }
            }
        }
    }
    return estaDentro;
}

// -------------------------------------------------------------
// FILTRADO Y RENDERIZADO
// -------------------------------------------------------------
function filtrarPorFecha(datos, fechaInicio, fechaFin) {
    const start = fechaInicio ? new Date(fechaInicio) : new Date('2000-01-01');
    let end = fechaFin ? new Date(fechaFin) : new Date();
    end.setHours(23, 59, 59, 999);
    return datos.filter(item => {
        const fechaItem = encontrarFecha(item);
        if (!fechaItem) return true; 
        return fechaItem >= start && fechaItem <= end;
    });
}

function renderizarMarcadores(datos, layerGroup, opciones) {
    datos.forEach(item => {
        let geom = parseGeom(item);
        if (geom) {
            const marker = L.circleMarker([geom.lat, geom.lng], {
                radius: opciones.radius || 5,
                fillColor: opciones.color || "#ff0000",
                color: "#000",
                weight: 1,
                opacity: 1,
                fillOpacity: opciones.fillOpacity || 0.7
            });
            if (opciones.popupFormatter) marker.bindPopup(opciones.popupFormatter(item));
            marker.addTo(layerGroup);
        }
    });
}

function renderizarCapas(fechaInicio = null, fechaFin = null) {
    reportesLayerGroup.clearLayers();
    const repPorFecha = filtrarPorFecha(allReportesData, fechaInicio, fechaFin);
    renderizarMarcadores(repPorFecha, reportesLayerGroup, {
        radius: 6, color: "#ffa500", fillOpacity: 0.8,
        popupFormatter: (item) => {
            let tipoBonito = normalizarTexto(encontrarTipo(item));
            const fecha = encontrarFecha(item);
            let victimasStr = '';
            if(parseInt(item.Fallecidos || 0) > 0) victimasStr += `<br><span style="color:red;">Fallecidos: ${item.Fallecidos}</span>`;
            if(parseInt(item.Heridos || 0) > 0) victimasStr += `<br><span style="color:orange;">Heridos: ${item.Heridos}</span>`;
            return `<b>${tipoBonito}</b><br><span style="font-size:10px;">${fecha ? fecha.toLocaleDateString('es-EC') : 'Reciente'}</span>${victimasStr}<br>${item.descripcion || ''}`;
        }
    });
    actualizarHeatmap(repPorFecha);
    actualizarDashboard(repPorFecha);
}

function aplicarFiltrosFecha() {
    renderizarCapas(document.getElementById('dateStart').value, document.getElementById('dateEnd').value);
}

function parseGeom(item) {
    if (item.latitud && item.longitud) return { lat: parseFloat(item.latitud), lng: parseFloat(item.longitud) };
    let g = item.geom || item.geometry || item.geojson;
    if (typeof g === 'string') try { g = JSON.parse(g); } catch (e) { }
    if (g && g.coordinates) return { lat: g.coordinates[1], lng: g.coordinates[0] };
    return null;
}

// -------------------------------------------------------------
// MAPA DE CALOR
// -------------------------------------------------------------
function actualizarHeatmap(repData) {
    let puntos = [];
    if (repData) {
        repData.forEach(item => {
            if (normalizarTexto(encontrarTipo(item)) === 'Colision vehicular') { 
                let g = parseGeom(item);
                if(g) puntos.push([g.lat, g.lng, 1.0]); 
            }
        });
    }
    if (heatmapLayer) map.removeLayer(heatmapLayer);
    if (puntos.length > 0 && typeof L.heatLayer === 'function') {
        heatmapLayer = L.heatLayer(puntos, { radius: 40, blur: 25, maxZoom: 15, max: 3.0, minOpacity: 0.5, gradient: { 0.3: 'blue', 0.6: 'yellow', 1.0: 'red' } });
        if (document.getElementById('heatmapToggle')?.checked) heatmapLayer.addTo(map);
    }
}

document.getElementById('heatmapToggle')?.addEventListener('change', e => {
    if (heatmapLayer) e.target.checked ? map.addLayer(heatmapLayer) : map.removeLayer(heatmapLayer);
});

// -------------------------------------------------------------
// DASHBOARD
// -------------------------------------------------------------
function actualizarDashboard(repFiltered) {
    const rep = repFiltered || allReportesData;
    const countsByType = {};
    const countsByMonth = {};
    
    rep.forEach(item => {
        const cleanType = normalizarTexto(encontrarTipo(item));
        const nf = parseInt(item.Fallecidos || 0);
        const nh = parseInt(item.Heridos || 0);
        if (nf > 0) countsByType['Fallecidos'] = (countsByType['Fallecidos'] || 0) + nf;
        if (nh > 0) countsByType['Heridos'] = (countsByType['Heridos'] || 0) + nh;
        if (!['Fallecidos', 'Heridos'].includes(cleanType)) countsByType[cleanType] = (countsByType[cleanType] || 0) + 1;
        
        const d = encontrarFecha(item); 
        if (d) {
            const key = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
            countsByMonth[key] = (countsByMonth[key] || 0) + 1;
        }
    });

    const sortedMonths = Object.keys(countsByMonth).sort();
    const isFiltered = document.getElementById('dateStart')?.value || document.getElementById('dateEnd')?.value;
    let monthsToShow = (!isFiltered && sortedMonths.length > 3) ? sortedMonths.slice(-3) : sortedMonths;

    if (chartInstanceType) chartInstanceType.destroy();
    chartInstanceType = new Chart(document.getElementById('typeChart').getContext('2d'), {
        type: 'doughnut',
        data: { labels: Object.keys(countsByType), datasets: [{ data: Object.values(countsByType), backgroundColor: ['#ef4444', '#f97316', '#3b82f6', '#a855f7', '#22c55e', '#eab308'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2, plugins: { legend: { position: 'right', labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 10 } } } }
    });

    if (chartInstanceTime) chartInstanceTime.destroy();
    chartInstanceTime = new Chart(document.getElementById('timeChart').getContext('2d'), {
        type: 'bar',
        data: { labels: monthsToShow, datasets: [{ label: 'Siniestros', data: monthsToShow.map(m => countsByMonth[m]), backgroundColor: '#3b82f6', borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: true, aspectRatio: 2, scales: { y: { beginAtZero: true, ticks: { color: '#cbd5e1' }, grid: { color: '#334155' } }, x: { ticks: { color: '#cbd5e1', maxRotation: 45 }, grid: { display: false } } }, plugins: { legend: { display: false } } }
    });
}

// -------------------------------------------------------------
// CARGA INICIAL
// -------------------------------------------------------------
async function loadLayer(tableName) {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?select=*`, {
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' }
        });
        return await response.json();
    } catch (e) { return []; }
}

async function init() {
    allReportesData = await loadLayer('reportes') || [];
    const perimetroData = await loadLayer('perimetro_urbano') || [];
    perimetroLayerGroup.clearLayers();
    perimetroData.forEach(item => {
        if (item.geom) {
            L.geoJSON(item.geom, { style: { color: '#0000ff', weight: 2, fillOpacity: 0.05 } }).addTo(perimetroLayerGroup);
            urbanPolygons.push(typeof item.geom === 'string' ? JSON.parse(item.geom) : item.geom);
        }
    });
    renderizarCapas();
}

// -------------------------------------------------------------
// FORMULARIO
// -------------------------------------------------------------
document.getElementById('reportForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const lat = parseFloat(document.getElementById('latitud').value);
    const lon = parseFloat(document.getElementById('longitud').value);
    if (!validarUbicacionUrbana(lat, lon)) { mostrarEstadoForm('⚠️ Ubicación fuera de zona permitida.', 'error'); return; }

    try {
        const hoy = new Date();
        const fechaActualDate = `${hoy.getFullYear()}-${(hoy.getMonth() + 1).toString().padStart(2, '0')}-${hoy.getDate().toString().padStart(2, '0')}`;
        const res = await fetch(`${SUPABASE_URL}/rest/v1/reportes`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitud: lat, longitud: lon, tipo_reporte: document.getElementById('tipoReporte').value, descripcion: document.getElementById('descripcion').value, date: fechaActualDate })
        });
        if (!res.ok) throw new Error();
        mostrarEstadoForm('¡Enviado!', 'success');
        document.getElementById('reportForm').reset();
        allReportesData = await loadLayer('reportes');
        renderizarCapas();
    } catch (err) { mostrarEstadoForm('Error en envío', 'error'); }
});

function obtenerUbicacion() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
            const lat = p.coords.latitude; const lng = p.coords.longitude;
            document.getElementById('latitud').value = lat.toFixed(6);
            document.getElementById('longitud').value = lng.toFixed(6);
            map.setView([lat, lng], 16);
            if (tempMarker) map.removeLayer(tempMarker);
            tempMarker = L.marker([lat, lng]).addTo(map).bindPopup('Tu ubicación').openPopup();
        });
    } else alert('GPS no disponible');
}

map.on('click', e => {
    document.getElementById('latitud').value = e.latlng.lat.toFixed(6);
    document.getElementById('longitud').value = e.latlng.lng.toFixed(6);
    if (tempMarker) map.removeLayer(tempMarker);
    tempMarker = L.marker(e.latlng).addTo(map).bindPopup('Ubicación').openPopup();
});

document.getElementById('perimetroLayer').addEventListener('change', e => e.target.checked ? map.addLayer(perimetroLayerGroup) : map.removeLayer(perimetroLayerGroup));
document.getElementById('reportesLayer').addEventListener('change', e => e.target.checked ? map.addLayer(reportesLayerGroup) : map.removeLayer(reportesLayerGroup));

// -------------------------------------------------------------
// GENERACIÓN DE PDF (CON GUÍA DE DATOS)
// -------------------------------------------------------------
async function descargarPDF() {
    if (!window.jspdf) { alert("Error: Librería PDF no cargada."); return; }
    const lat = document.getElementById('latitud').value;
    const lng = document.getElementById('longitud').value;
    if (!lat || !lng) { alert("⚠️ Selecciona una ubicación primero."); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const colorBlue = [59, 130, 246]; const colorDark = [15, 23, 42];

    doc.setFillColor(...colorBlue); doc.rect(0, 0, 210, 30, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(22);
    doc.text("RIOBAMBA SEGURA", 105, 15, { align: "center" });
    doc.setFontSize(12); doc.text("Reporte de Incidente / Siniestro", 105, 24, { align: "center" });

    doc.setTextColor(100); doc.setFontSize(10); doc.text(`Generado el: ${new Date().toLocaleString('es-EC')}`, 20, 42);
    doc.setDrawColor(200); doc.line(20, 45, 190, 45);

    let y = 55;
    doc.setTextColor(...colorDark); doc.setFontSize(14); doc.text("Detalles del Evento", 20, y);
    y += 10; doc.setFontSize(12); doc.text(`Tipo: ${document.getElementById('tipoReporte').value}`, 20, y);
    y += 8; doc.text(`Ubicación: Lat: ${lat} | Lng: ${lng}`, 20, y);
    
    y += 15; doc.text("Descripción:", 20, y);
    y += 5; doc.setFillColor(248, 250, 252); doc.rect(20, y, 170, 30, 'F');
    doc.setFontSize(10); doc.text(doc.splitTextToSize(document.getElementById('descripcion').value || "Sin descripción proporcionada.", 160), 25, y + 10);

    // --- SECCIÓN: GUÍA PARA USO DE DATOS (NUEVO) ---
    y += 45;
    doc.setDrawColor(...colorBlue); doc.setLineWidth(0.5); doc.line(20, y, 190, y);
    y += 10; doc.setFontSize(13); doc.setTextColor(...colorBlue); doc.text("GUÍA PARA USO DE DATOS ABIERTOS", 20, y);
    
    doc.setTextColor(50); doc.setFontSize(9); y += 8;
    const guiaText = "Metodología: Los archivos descargados son en formato GeoJSON para análisis en software SIG. IMPORTANTE: Realizar una proyección al sistema UTM Zona 17 Sur (EPSG:32717) ya que los datos vienen por defecto en coordenadas geográficas WGS 84 (EPSG:4326).\n\nModo de uso: Al descargar la información, encontrará campos como 'Fallecidos' y 'Heridos' (numéricos), así como 'date' y 'hora' para análisis temporal. La coordenada exacta reside en la geometría del punto.";
    doc.text(doc.splitTextToSize(guiaText, 170), 20, y);

    doc.setFontSize(8); doc.setTextColor(150);
    doc.text("Documento Oficial - GeoPortal Seguridad Vial Riobamba", 105, 285, { align: "center" });
    doc.save(`Reporte_Riobamba_${Date.now()}.pdf`);
}

// -------------------------------------------------------------
// GENERACIÓN DE GEOJSON (DATOS ABIERTOS)
// -------------------------------------------------------------
function descargarGeoJSON() {
    if (allReportesData.length === 0) return;
    const features = allReportesData.map(item => {
        const geom = parseGeom(item);
        return geom ? { type: "Feature", geometry: { type: "Point", coordinates: [geom.lng, geom.lat] }, properties: { ...item } } : null;
    }).filter(f => f);

    const geojson = {
        type: "FeatureCollection",
        metadata: {
            titulo: "Datos abiertos Geo Portal Seguridad Vial Riobamba",
            descripcion: "Iniciativa para el análisis de incidentes de tránsito en Riobamba para prevención y toma de decisiones.",
            metodologia: "Formato GeoJSON (EPSG:4326). Se recomienda proyectar a UTM Zona 17 Sur (EPSG:32717). Fuente: Recopilación bibliográfica local.",
            modo_de_uso: "Utilizar campos 'date', 'hora', 'Fallecidos' y 'Heridos' para análisis estadístico."
        },
        crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
        features: features
    };

    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json" });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reportes_riobamba_${new Date().toISOString().split('T')[0]}.geojson`;
    a.click();
}

init();