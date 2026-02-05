const SUPABASE_URL = 'https://pnaobmyaugbccfwwhyob.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuYW9ibXlhdWdiY2Nmd3doeW9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgzMzQwMzcsImV4cCI6MjA4MzkxMDAzN30.-TwJWOKZWXNDq2u789-dRcX--yA4fWjGSgHc-Zr-ny4';

// Mapa
const map = L.map('map').setView([-1.6635, -78.6547], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19, opacity: 1 }).addTo(map);

// Grupos de capas
let accidentesLayerGroup = L.layerGroup().addTo(map);
let perimetroLayerGroup = L.layerGroup();
let reportesLayerGroup = L.layerGroup().addTo(map);
let heatmapLayer = null;
let tempMarker = null;

// ALMACÉN DE DATOS
let allAccidentesData = [];
let allReportesData = [];

// ALMACÉN DE GEOMETRÍA (Para validación de perímetro)
let urbanPolygons = []; 

// Variables de Gráficos
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

// -------------------------------------------------------------
// NORMALIZACIÓN Y BÚSQUEDA INTELIGENTE
// -------------------------------------------------------------
function normalizarTexto(texto) {
    if (!texto) return 'No especificado';

    // 1. Convertir a minúsculas, quitar tildes y caracteres especiales
    let limpio = texto.toString()
        .toLowerCase()
        .replace(/_/g, ' ')
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 2. Capitalizar la primera letra
    return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

// BUSCADOR DE FECHAS (FIX MATEMÁTICO -5 HORAS)
function encontrarFecha(item) {
    const fechaStr = item.fecha || item.fecha_reporte || item.created_at;

    if (fechaStr) {
        let fecha = new Date(fechaStr);

        if (!isNaN(fecha)) {
            // RESTA FORZADA DE 5 HORAS para ajustar UTC a Ecuador
            fecha.setTime(fecha.getTime() - (5 * 60 * 60 * 1000));
            return fecha;
        }
    }
    return null;
}

// BUSCADOR DE TIPOS
function encontrarTipo(item) {
    const tipo = item.sv || item.tipo_reporte || item.tipo_incidente || item.tipo || 'Otros';
    return tipo;
}

// -------------------------------------------------------------
// VALIDACIÓN GEOGRÁFICA (Ray Casting Algorithm)
// -------------------------------------------------------------
function isPointInPolygon(point, vs) {
    var x = point[0], y = point[1];
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        var xi = vs[i][0], yi = vs[i][1];
        var xj = vs[j][0], yj = vs[j][1];
        var intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
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
            if (isPointInPolygon(punto, geojson.coordinates[0])) {
                estaDentro = true;
                break;
            }
        } else if (geojson.type === 'MultiPolygon') {
            for (let polyCoords of geojson.coordinates) {
                if (isPointInPolygon(punto, polyCoords[0])) {
                    estaDentro = true;
                    break;
                }
            }
        }
    }
    return estaDentro;
}

// -------------------------------------------------------------
// UTILIDADES DE FILTRADO
// -------------------------------------------------------------
function filtrarPorFecha(datos, fechaInicio, fechaFin) {
    const start = fechaInicio ? new Date(fechaInicio) : new Date('2000-01-01');
    let end;
    if (fechaFin) {
        end = new Date(fechaFin);
    } else {
        end = new Date(); 
    }
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

            if (opciones.popupFormatter) {
                marker.bindPopup(opciones.popupFormatter(item));
            }

            marker.addTo(layerGroup);
        }
    });
}

// -------------------------------------------------------------
// LÓGICA DE FILTROS Y DIBUJADO EN MAPA
// -------------------------------------------------------------
function renderizarCapas(fechaInicio = null, fechaFin = null) {
    accidentesLayerGroup.clearLayers();
    reportesLayerGroup.clearLayers();
    
    // 1. Filtrado Base por Fecha
    const accPorFecha = filtrarPorFecha(allAccidentesData, fechaInicio, fechaFin);
    const repPorFecha = filtrarPorFecha(allReportesData, fechaInicio, fechaFin);

    // 2. Renderizar Marcadores (Mostramos TODO lo que pase el filtro de fecha)
    // Ya no filtramos por "Tipo" porque asumimos que el usuario quiere ver los incidentes.
    
    // Accidentes (Capa Histórica)
    renderizarMarcadores(accPorFecha, accidentesLayerGroup, {
        radius: 5,
        color: "#ff0000",
        fillOpacity: 0.7,
        popupFormatter: (item) => {
            let tipoBonito = normalizarTexto(encontrarTipo(item));
            let content = `<b>${tipoBonito}</b><br>`;
            const fecha = encontrarFecha(item);
            if (fecha) content += `Fecha: ${fecha.toLocaleDateString()}<br>`;
            if (item.direccion) content += `Dirección: ${item.direccion}`;
            return content;
        }
    });

    // Reportes (Capa Ciudadana)
    renderizarMarcadores(repPorFecha, reportesLayerGroup, {
        radius: 7,
        color: "#ffa500", 
        fillOpacity: 0.8,
        popupFormatter: (item) => {
            let tipoBonito = normalizarTexto(encontrarTipo(item));
            const fecha = encontrarFecha(item);
            let fechaStr = fecha ? fecha.toLocaleString('es-EC') : 'Reciente';

            return `<b>${tipoBonito}</b><br>
                    <span style="font-size:10px; color:#666">${fechaStr}</span><br>
                    ${item.descripcion || ''}`;
        }
    });

    // 3. Actualizar Heatmap
    actualizarHeatmap(accPorFecha, repPorFecha);

    // 4. Dashboard (Refleja lo que se ve en el mapa)
    actualizarDashboard(accPorFecha, repPorFecha);
}

function aplicarFiltrosFecha() {
    const startVal = document.getElementById('dateStart').value;
    const endVal = document.getElementById('dateEnd').value;
    renderizarCapas(startVal, endVal);
}

function parseGeom(item) {
    if (item.latitud && item.longitud) return { lat: item.latitud, lng: item.longitud };
    let g = item.geom || item.geometry || item.geojson;
    if (typeof g === 'string') try { g = JSON.parse(g); } catch (e) { }
    if (g && g.coordinates) return { lat: g.coordinates[1], lng: g.coordinates[0] };
    return null;
}

// -------------------------------------------------------------
// MAPA DE CALOR (CALIBRADO: 1=Azul, 2=Amarillo, 3=Rojo)
// -------------------------------------------------------------
function actualizarHeatmap(accData, repData) {
    let puntos = [];

    // 1. Accidentes Históricos
    if (accData) {
        accData.forEach(item => {
            let tipo = normalizarTexto(encontrarTipo(item));
            // Tu pedido: "Solo se aplique para colision vehicular".
            if (tipo === 'Colision vehicular') {
                let g = parseGeom(item);
                if(g) puntos.push([g.lat, g.lng, 1.0]); 
            }
        });
    }

    // 2. Reportes Ciudadanos (SOLO Colisión Vehicular)
    if (repData) {
        repData.forEach(item => {
            let tipo = normalizarTexto(encontrarTipo(item));
            if (tipo === 'Colision vehicular') { 
                let g = parseGeom(item);
                if(g) puntos.push([g.lat, g.lng, 1.0]); 
            }
        });
    }

    if (heatmapLayer) map.removeLayer(heatmapLayer);

    if (puntos.length > 0 && typeof L.heatLayer === 'function') {
        heatmapLayer = L.heatLayer(puntos, {
            radius: 40,      
            blur: 25,        
            maxZoom: 15,
            
            max: 3.0,        
            minOpacity: 0.5, 
            
            gradient: { 
                0.3: 'blue',   
                0.6: 'yellow', 
                1.0: 'red'     
            }
        });
        
        if (document.getElementById('heatmapToggle') && document.getElementById('heatmapToggle').checked) {
            heatmapLayer.addTo(map);
        }
    }
}

// Evento para prender/apagar calor
const heatToggle = document.getElementById('heatmapToggle');
if(heatToggle) {
    heatToggle.addEventListener('change', e => {
        if (heatmapLayer) {
            if (e.target.checked) {
                map.addLayer(heatmapLayer);
            } else {
                map.removeLayer(heatmapLayer);
            }
        }
    });
}

// -------------------------------------------------------------
// ESTADÍSTICAS (Ventana Deslizante)
// -------------------------------------------------------------
function actualizarDashboard(accFiltered, repFiltered) {
    const acc = accFiltered || allAccidentesData;
    const rep = repFiltered || allReportesData;
    const combined = [...acc, ...rep];

    // 1. Contar por TIPO
    const countsByType = {};
    combined.forEach(item => {
        const rawType = encontrarTipo(item);
        const cleanType = normalizarTexto(rawType);
        countsByType[cleanType] = (countsByType[cleanType] || 0) + 1;
    });

    // 2. Contar por MES
    const countsByMonth = {};
    combined.forEach(item => {
        const d = encontrarFecha(item); 
        if (d) {
            const key = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
            countsByMonth[key] = (countsByMonth[key] || 0) + 1;
        }
    });

    // LÓGICA DE VENTANA DESLIZANTE
    const sortedMonths = Object.keys(countsByMonth).sort();
    
    const startVal = document.getElementById('dateStart') ? document.getElementById('dateStart').value : '';
    const endVal = document.getElementById('dateEnd') ? document.getElementById('dateEnd').value : '';
    const isFiltered = startVal || endVal;

    let monthsToShow = sortedMonths;

    // Si NO hay filtro activo y tenemos más de 4 meses, cortamos y mostramos solo los últimos 4
    if (!isFiltered && sortedMonths.length > 4) {
        monthsToShow = sortedMonths.slice(-4);
    }

    // --- GRÁFICO DE PASTEL ---
    const ctxType = document.getElementById('typeChart').getContext('2d');
    if (chartInstanceType) chartInstanceType.destroy();

    chartInstanceType = new Chart(ctxType, {
        type: 'doughnut',
        data: {
            labels: Object.keys(countsByType),
            datasets: [{
                data: Object.values(countsByType),
                backgroundColor: ['#ef4444', '#3b82f6', '#f97316', '#a855f7', '#22c55e', '#eab308'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            layout: { padding: 0 },
            plugins: {
                legend: {
                    position: 'right',
                    labels: { color: '#cbd5e1', font: { size: 10 }, boxWidth: 10, padding: 10 }
                }
            }
        }
    });

    // --- GRÁFICO DE BARRAS ---
    const ctxTime = document.getElementById('timeChart').getContext('2d');
    if (chartInstanceTime) chartInstanceTime.destroy();

    chartInstanceTime = new Chart(ctxTime, {
        type: 'bar',
        data: {
            labels: monthsToShow,
            datasets: [{
                label: 'Incidentes',
                data: monthsToShow.map(m => countsByMonth[m]),
                backgroundColor: '#3b82f6',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            scales: {
                y: { beginAtZero: true, ticks: { color: '#cbd5e1' }, grid: { color: '#334155' } },
                x: { 
                    ticks: { 
                        color: '#cbd5e1',
                        autoSkip: true,   
                        maxRotation: 0,   
                        minRotation: 0
                    }, 
                    grid: { display: false } 
                }
            },
            plugins: { legend: { display: false } }
        }
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
        const data = await response.json();
        return data;
    } catch (error) {
        console.error(error);
        return [];
    }
}

async function init() {
    allAccidentesData = await loadLayer('accidentes') || [];
    allReportesData = await loadLayer('reportes') || [];

    const perimetroData = await loadLayer('perimetro_urbano') || [];
    
    // Guardamos la geometría del perímetro para validación
    urbanPolygons = []; 
    perimetroLayerGroup.clearLayers();
    
    perimetroData.forEach(item => {
        if (item.geom) {
            L.geoJSON(item.geom, { style: { color: '#0000ff', weight: 2, fillOpacity: 0.05 } }).addTo(perimetroLayerGroup);
            let g = typeof item.geom === 'string' ? JSON.parse(item.geom) : item.geom;
            urbanPolygons.push(g);
        }
    });

    renderizarCapas();
}

// -------------------------------------------------------------
// ENVÍO DE FORMULARIO
// -------------------------------------------------------------
document.getElementById('reportForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const lat = parseFloat(document.getElementById('latitud').value);
    const lon = parseFloat(document.getElementById('longitud').value);
    // Ahora leemos el valor fijo del campo oculto
    const tipo = document.getElementById('tipoReporte').value;
    const desc = document.getElementById('descripcion').value;

    // VALIDACIÓN DE SEGURIDAD
    if (!validarUbicacionUrbana(lat, lon)) {
        mostrarEstadoForm('⚠️ Ubicación fuera de la zona urbana permitida.', 'error');
        return; 
    }

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/reportes`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json', 'Prefer': 'return=representation'
            },
            body: JSON.stringify({ latitud: lat, longitud: lon, tipo_reporte: tipo, descripcion: desc })
        });

        if (!res.ok) throw new Error('Error envío');

        mostrarEstadoForm('¡Enviado!', 'success');
        document.getElementById('reportForm').reset();

        // Recargar datos
        allReportesData = await loadLayer('reportes');
        // Re-renderizar filtros
        const start = document.getElementById('dateStart').value;
        const end = document.getElementById('dateEnd').value;
        renderizarCapas(start, end);

    } catch (err) { mostrarEstadoForm('Error: ' + err.message, 'error'); }
});

// Geolocalización y Clicks
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

document.getElementById('accidentesLayer').addEventListener('change', e => e.target.checked ? map.addLayer(accidentesLayerGroup) : map.removeLayer(accidentesLayerGroup));
document.getElementById('perimetroLayer').addEventListener('change', e => e.target.checked ? map.addLayer(perimetroLayerGroup) : map.removeLayer(perimetroLayerGroup));
document.getElementById('reportesLayer').addEventListener('change', e => e.target.checked ? map.addLayer(reportesLayerGroup) : map.removeLayer(reportesLayerGroup));

// MOBILE FIX
if (document.getElementById('panelHandle')) {
    document.getElementById('panelHandle').addEventListener('click', function () {
        togglePanel();
    });
}

// -------------------------------------------------------------
// GENERACIÓN DE PDF
// -------------------------------------------------------------
async function descargarPDF() {
    if (!window.jspdf) {
        alert("Librería PDF no cargada. Por favor recargue la página.");
        return;
    }

    const latInput = document.getElementById('latitud');
    const lonInput = document.getElementById('longitud');
    // Aunque oculto, sigue siendo el valor a imprimir
    const tipoInput = document.getElementById('tipoReporte');
    const descInput = document.getElementById('descripcion');

    const lat = latInput ? latInput.value : '';
    const lng = lonInput ? lonInput.value : '';

    if (!lat || !lng || parseFloat(lat) === 0 || parseFloat(lng) === 0) {
        alert("⚠️ Por favor, obtén tu ubicación o selecciona un punto en el mapa antes de generar el informe.");
        return;
    }

    let tipoTexto = tipoInput ? tipoInput.value : 'Colisión Vehicular';

    const descripcion = descInput ? descInput.value : 'Sin descripción detallada proporcionada en el momento de la generación del reporte.';

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const colorBlue = [59, 130, 246]; 
    const colorDark = [15, 23, 42];  

    doc.setFillColor(...colorBlue);
    doc.rect(0, 0, 210, 30, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("RIOBAMBA SEGURA", 105, 15, { align: "center" });

    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");
    doc.text("Reporte de Incidente / Siniestro", 105, 24, { align: "center" });

    doc.setTextColor(0, 0, 0);
    const startY = 50;

    const fecha = new Date().toLocaleString('es-EC');
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generado el: ${fecha}`, 20, 42);
    doc.setDrawColor(200);
    doc.line(20, 45, 190, 45); 

    let yPos = startY;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...colorDark);
    doc.text("Detalles del Evento", 20, yPos);
    yPos += 10;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(50);
    doc.text("Tipo de Incidente:", 20, yPos);
    doc.setFont("helvetica", "normal");
    doc.text(tipoTexto, 70, yPos);
    yPos += 12;

    doc.setFont("helvetica", "bold");
    doc.text("Ubicación Geográfica:", 20, yPos);
    doc.setFont("helvetica", "normal");
    doc.text(`Latitud: ${lat}   |   Longitud: ${lng}`, 70, yPos);
    yPos += 8;

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text("(Coordenadas WGS84 capturadas del visor de mapas)", 70, yPos);
    yPos += 15;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(50);
    doc.text("Descripción del Reporte:", 20, yPos);
    yPos += 8;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.rect(20, yPos, 170, 40, 'FD');

    doc.setFont("helvetica", "normal");
    doc.setTextColor(30);
    doc.setFontSize(11);

    const splitText = doc.splitTextToSize(descripcion, 160);
    doc.text(splitText, 25, yPos + 10);

    const pageHeight = doc.internal.pageSize.height;
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text("Documento Oficial - GeoPortal de Seguridad Vial GAD Riobamba", 105, pageHeight - 15, { align: "center" });
    doc.text("Este documento es informativo y no constituye una denuncia legal formal.", 105, pageHeight - 10, { align: "center" });

    doc.save(`Reporte_Incidente_${Date.now()}.pdf`);
}

init();