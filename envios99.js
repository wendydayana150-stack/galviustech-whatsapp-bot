// INTEGRACION CON 99ENVIOS (oct-2026, Wendy: "integra 99 envios al bot para envios").
// Desde el panel admin, Wendy revisa un pedido, lo cotiza con Interrapidisimo y crea la guia con un clic.
// 99Envios avisa los cambios de estado por webhook y Michell le cuenta al cliente por WhatsApp.
// Documentacion: 99envios.co > Configuracion > Integraciones > API B2B > Documentacion.
// Credenciales (variables de entorno en Render, nunca en el repo):
//   ENVIOS99_API_KEY   key de comercio (99e_...), se genera en la plataforma 99Envios
//   ENVIOS99_SECRET    secret HMAC del comercio (lo entrega 99Envios al habilitar el acceso B2B)
//   ENVIOS99_ENV       "production" para operar de verdad; si falta se usa "sandbox" (no guarda nada)
//   ENVIOS99_TENANT_ID opcional: si esta, el webhook rechaza avisos de otro comercio
const crypto = require("crypto");
const axios = require("axios");
const dane = require("./dane.json");

const BASE = "https://api.99envios.co";
const PREFIJO = "/api/dev/v1";
const CARRIER = "interrapidisimo";

function configurado() {
      return !!(process.env.ENVIOS99_API_KEY && process.env.ENVIOS99_SECRET);
}

function entorno() {
      return /^prod/i.test(process.env.ENVIOS99_ENV || "") ? "production" : "sandbox";
}

// Firma de cada peticion: HMAC-SHA256 de "{timestamp}.{METODO}.{ruta}.{cuerpo}" con el secret
function firmar(secret, timestamp, metodo, ruta, cuerpo) {
      return crypto.createHmac("sha256", secret).update(`${timestamp}.${metodo.toUpperCase()}.${ruta}.${cuerpo}`).digest("hex");
}

async function llamar(metodo, ruta, payload) {
      if (!configurado()) throw new Error("Falta configurar ENVIOS99_API_KEY y ENVIOS99_SECRET en Render");
      const path = PREFIJO + ruta;
      const cuerpo = payload === undefined ? "" : JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000).toString();
      const headers = {
            "X-API-Key": process.env.ENVIOS99_API_KEY,
            "X-Timestamp": ts,
            "X-Signature": firmar(process.env.ENVIOS99_SECRET, ts, metodo, path, cuerpo),
            "X-Environment": entorno(),
      };
      if (cuerpo) headers["Content-Type"] = "application/json";
      try {
            // transformRequest deja el cuerpo exactamente como se firmo (sin volver a serializarlo)
            const r = await axios({ method: metodo, url: BASE + path, data: cuerpo || undefined, headers, transformRequest: [(d) => d], timeout: 30000 });
            return r.data?.data;
      } catch (error) {
            const datos = error.response?.data;
            const detalle = datos?.message || datos?.detail || datos?.error_code || error.message;
            const e = new Error(`99Envios respondio ${error.response?.status || "sin respuesta"}: ${typeof detalle === "string" ? detalle : JSON.stringify(detalle)}`);
            e.status = error.response?.status;
            throw e;
      }
}

// ---------- Municipios (codigo DANE de 8 digitos = municipio + "000", la cabecera) ----------
function normalizar(t) {
      return String(t || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toUpperCase()
            .replace(/[^A-Z0-9 ]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
}
const MUNICIPIOS = dane.map((x) => ({ ...x, nd: normalizar(x.d), nm: normalizar(x.m) }));
// Como los escriben los clientes vs. el nombre oficial
const ALIAS_MUNICIPIO = { "BOGOTA": "BOGOTA D C", "CUCUTA": "SAN JOSE DE CUCUTA", "CARTAGENA": "CARTAGENA DE INDIAS", "TUMACO": "SAN ANDRES DE TUMACO", "MOMPOX": "SANTA CRUZ DE MOMPOX", "SANTAFE DE ANTIOQUIA": "SANTA FE DE ANTIOQUIA", "UBATE": "VILLA DE SAN DIEGO DE UBATE", "TOLU": "SANTIAGO DE TOLU" };
const ALIAS_DEPARTAMENTO = { "VALLE": "VALLE DEL CAUCA", "BOGOTA": "BOGOTA D C", "SAN ANDRES": "ARCHIPIELAGO DE SAN ANDRES PROVIDENCIA Y SANTA CATALINA", "GUAJIRA": "LA GUAJIRA", "NORTE SANTANDER": "NORTE DE SANTANDER" };

function contienePalabras(texto, frase) {
      return (" " + texto + " ").includes(" " + frase + " ");
}

// Devuelve los municipios que coinciden con la ciudad (y el departamento) que dio el cliente, el mejor primero.
// Si hay exactamente uno, ese es el destino; si hay varios o ninguno, Wendy elige en el panel.
function buscarMunicipio(ciudad, departamento) {
      let c = normalizar(ciudad);
      let d = normalizar(departamento);
      d = ALIAS_DEPARTAMENTO[d] || d;
      const delDepto = d ? MUNICIPIOS.filter((m) => m.nd === d || m.nd.startsWith(d + " ") || d.startsWith(m.nd)) : [];
      // "Tauramena Casanare": se quita el departamento del texto de la ciudad
      for (const dep of new Set(MUNICIPIOS.map((m) => m.nd))) if (contienePalabras(c, dep) && c !== dep) c = (" " + c + " ").replace(" " + dep + " ", " ").trim();
      c = ALIAS_MUNICIPIO[c] || c;
      if (!c) return [];
      const puntuar = (lista) =>
            lista
                  .map((m) => ({ m, p: m.nm === c || m.nm.replace(/ /g, "") === c.replace(/ /g, "") ? 3 : contienePalabras(c, m.nm) ? 2 : contienePalabras(m.nm, c) ? 1 : 0 }))
                  .filter((x) => x.p > 0)
                  .sort((a, b) => b.p - a.p || b.m.nm.length - a.m.nm.length)
                  .map((x) => x.m);
      let res = delDepto.length ? puntuar(delDepto) : [];
      if (!res.length) res = puntuar(MUNICIPIOS);
      // Coincidencia exacta gana sobre las parciales
      if (res.length > 1 && res[0].nm === c && res[1].nm !== c) res = [res[0]];
      return res.slice(0, 15).map((m) => ({ codigo: m.c, municipio: m.m, departamento: m.d }));
}

// Todos los municipios del departamento (para que Wendy elija cuando el cliente escribio una vereda o algo raro)
function municipiosDelDepartamento(departamento) {
      let d = normalizar(departamento);
      d = ALIAS_DEPARTAMENTO[d] || d;
      if (!d) return [];
      return MUNICIPIOS.filter((m) => m.nd === d || m.nd.startsWith(d + " ") || d.startsWith(m.nd)).map((m) => ({ codigo: m.c, municipio: m.m, departamento: m.d }));
}

// ---------- Paquete por categoria (PENDIENTE-WENDY: confirmar pesos y medidas reales empacados) ----------
const PAQUETE_POR_CATEGORIA = {
      modem: { weight_kg: 0.6, length_cm: 20, width_cm: 15, height_cm: 8 },
      impresora: { weight_kg: 1, length_cm: 32, width_cm: 12, height_cm: 10 },
      lampara: { weight_kg: 1.5, length_cm: 30, width_cm: 20, height_cm: 15 },
      reloj: { weight_kg: 0.3, length_cm: 15, width_cm: 10, height_cm: 8 },
      smartwatch: { weight_kg: 0.3, length_cm: 15, width_cm: 10, height_cm: 8 },
      camara: { weight_kg: 0.8, length_cm: 20, width_cm: 15, height_cm: 15 },
      otros: { weight_kg: 1, length_cm: 25, width_cm: 20, height_cm: 12 },
};
function paquetePorDefecto(producto) {
      const id = producto?.id || "";
      if (id.startsWith("combo-")) return { weight_kg: 1.5, length_cm: 32, width_cm: 22, height_cm: 15 };
      return PAQUETE_POR_CATEGORIA[String(producto?.categoria || "").trim().toLowerCase()] || PAQUETE_POR_CATEGORIA.otros;
}

// ---------- Datos de la cotizacion a partir del pedido (ya revisados por Wendy en el panel) ----------
function datosCotizacion(f) {
      const cobra = f.contraentrega && Number(f.valorCobrar) > 0;
      return {
            carrier_code: CARRIER,
            destination_city_code: f.codigoDane,
            dimensions: {
                  weight_kg: Number(f.peso),
                  length_cm: Math.round(Number(f.largo)),
                  width_cm: Math.round(Number(f.ancho)),
                  height_cm: Math.round(Number(f.alto)),
            },
            declared_value: Math.round(Number(f.valorDeclarado)),
            applies_cod: !!cobra,
            ...(cobra ? { cod_amount: Math.round(Number(f.valorCobrar)) } : {}),
            delivery_type: f.tipoEntrega || "DOMICILIO",
            recipient: { name: f.nombre, phone: f.celular, address: f.direccion, city_code: f.codigoDane },
            items: [{ name: String(f.producto || "Producto GalviusTech").slice(0, 255), quantity: 1, unit_price: Math.round(Number(f.valorDeclarado)) }],
            content: String(f.producto || "").slice(0, 255) || undefined,
            observations: f.observaciones || undefined,
      };
}

async function cotizar(f) {
      return llamar("POST", "/quotes", datosCotizacion(f));
}

async function crearGuia(quoteId) {
      return llamar("POST", "/shipments", { quote_id: quoteId });
}

async function rastrear(tracking) {
      return llamar("GET", `/shipments/${encodeURIComponent(tracking)}/track`);
}

async function configurarWebhook(url) {
      return llamar("PUT", "/webhook", { name: "Michell GalviusTech", url, is_active: true });
}

// ---------- Webhook: verificar que el aviso viene de 99Envios ----------
// Firma: "v1=" + HMAC-SHA256 de "99envios.webhook.v1.{X-Webhook-Timestamp}.{cuerpo crudo}" con el mismo secret
function verificarWebhook(cuerpoCrudo, timestamp, firma) {
      const secret = process.env.ENVIOS99_SECRET;
      if (!secret || !cuerpoCrudo || !timestamp || !firma) return false;
      if (!/^\d+$/.test(String(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
      const esperada = "v1=" + crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`99envios.webhook.v1.${timestamp}.`), Buffer.from(cuerpoCrudo)])).digest("hex");
      const a = Buffer.from(esperada);
      const b = Buffer.from(String(firma));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Estados de guia (seccion 13.2 de la documentacion)
const ESTADOS = { 1: "Creado", 2: "En distribución", 3: "Entregado", 5: "Devuelto", 6: "Anulado", 7: "Otro", 8: "Error de rastreo", 9: "Novedad", 10: "Desactivado", 11: "Reclame en oficina", 12: "Reintegro", 13: "Indemnización", 14: "Indemnización de servicio", 15: "Descontinuado", 16: "Indemnizado", 17: "Pendiente de validación de entrega" };

module.exports = { configurado, entorno, firmar, buscarMunicipio, municipiosDelDepartamento, paquetePorDefecto, datosCotizacion, cotizar, crearGuia, rastrear, configurarWebhook, verificarWebhook, ESTADOS, CARRIER };
