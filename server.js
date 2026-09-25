require("dotenv").config();
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const catalogo = require("./catalog.json");
const config = require("./config.js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const subirArchivoChat = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 16 * 1024 * 1024 },
});

const {
        META_TOKEN,
        PHONE_NUMBER_ID,
        VERIFY_TOKEN,
        ANTHROPIC_API_KEY,
        GITHUB_TOKEN,
        GITHUB_OWNER,
        GITHUB_REPO,
        ADMIN_USER,
        ADMIN_PASS,
        PORT,
} = process.env;

const PUERTO = PORT || 3000;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const PEDIDOS_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/pedidos.json`;
const CLIENTES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/clientes.json`;
const CATALOGO_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/catalog.json`;

const ETAPAS = [
      { id: "Contacto inicial", emoji: "🔵" },
      { id: "Interaccion con IA", emoji: "🤖" },
      { id: "Cliente potencial", emoji: "🚩" },
      { id: "Datos completados", emoji: "✅" },
      { id: "No automatizado", emoji: "🔴" },
      { id: "Remarketing", emoji: "🔥" },
      { id: "No Califica", emoji: "⛔" },
      { id: "Subir a Dropi", emoji: "🟠" },
      { id: "Error al subir a Dropi", emoji: "❌" },
      { id: "Pedido programado", emoji: "⏰" },
      { id: "Oficina", emoji: "📦" },
      { id: "Intento de cancelacion", emoji: "❗" },
      ];

const sesiones = {};

function obtenerSesion(telefono) {
        if (!sesiones[telefono]) {
                  sesiones[telefono] = { paso: "inicio", pedido: {}, historial: [], transcripcion: [], pausado: false, ultimoProducto: null, ultimaCategoria: null, necesitaAtencion: false, motivoAtencion: null, pausarSeguimiento: false, preguntasPorProducto: {}, botonesOfrecidos: {} };
        }
        return sesiones[telefono];
}

// Reconstruye el historial que le pasamos a la IA (Claude) a partir de la
// transcripcion guardada, para que despues de un reinicio del servidor la IA
// siga teniendo el contexto de la conversacion (por ejemplo, para entender a
// que se refiere un cliente cuando responde algo corto como "no gracias").
function construirHistorialDesdeTranscripcion(conversacion) {
        const mensajes = [];
        for (const m of conversacion || []) {
                  if (!m || !m.texto) continue;
                  const role = m.rol === "cliente" ? "user" : "assistant";
                  const ultimo = mensajes[mensajes.length - 1];
                  // La API de Claude exige que los mensajes alternen user/assistant,
                  // asi que si hay varios mensajes seguidos del mismo rol (ej. el bot
                  // manda texto y luego una imagen) los combinamos en uno solo.
                  if (ultimo && ultimo.role === role) {
                              ultimo.content += "\n" + m.texto;
                  } else {
                              mensajes.push({ role, content: m.texto });
                  }
        }
        // El primer mensaje siempre debe ser del cliente ("user").
        while (mensajes.length > 0 && mensajes[0].role !== "user") {
                  mensajes.shift();
        }
        return mensajes.slice(-16);
}

async function cargarSesionSiNueva(telefono) {
        if (sesiones[telefono]) return;
        try {
                  const { datos } = await leerJSON(CLIENTES_API);
                  const cliente = datos.find((c) => c.telefono === telefono);
                  if (cliente) {
                              const enFlujoDePedido = cliente.paso && cliente.paso !== "inicio";
                              sesiones[telefono] = {
                                            paso: enFlujoDePedido ? cliente.paso : (cliente.pausado ? "conversando" : "inicio"),
                                            pedido: cliente.pedido || {},
                                            // Reconstruimos el historial para la IA a partir de la transcripcion
                                            // guardada, para que no pierda el contexto tras un reinicio.
                                            historial: construirHistorialDesdeTranscripcion(cliente.conversacion),
                                            // Siempre recuperamos el historial guardado, sin importar en que paso
                                            // quedo el cliente, para que el chat del panel nunca pierda mensajes
                                            // anteriores (por ejemplo despues de un reinicio del servidor).
                                            transcripcion: cliente.conversacion || [],
                                            pausado: !!cliente.pausado,
                                            ultimoProducto: cliente.pedido?.productoId || cliente.ultimoProducto || null,
                                            ultimaCategoria: cliente.ultimaCategoria || null,
                                            necesitaAtencion: !!cliente.necesitaAtencion,
                                            motivoAtencion: cliente.motivoAtencion || null,
                                            pausarSeguimiento: !!cliente.pausarSeguimiento,
                                            // Contadores en memoria (no se persisten en clientes.json): cuantas
                                            // veces ha preguntado sobre cada producto puntual en esta sesion, y
                                            // si ya se le ofrecieron los botones de "Si, quiero este / Ver otros"
                                            // para ese producto. Se reinician tras un reinicio del servidor, lo
                                            // cual esta bien: en el peor caso el cliente recibe los botones un
                                            // poco despues de lo ideal, nunca antes.
                                            preguntasPorProducto: {},
                                            botonesOfrecidos: {},
                              };
                              return;
                  }
        } catch (error) {
                  console.error("Error cargando sesion persistida:", error.response?.data || error.message);
        }
        obtenerSesion(telefono);
}

// Devuelve el registro que acaba de guardar (no solo lo empuja al arreglo) para que quien envia
// un mensaje del bot pueda, despues de que WhatsApp confirme el envio, anotarle el wamid (el id
// que WhatsApp le da a ese mensaje) en registro.wamid. Ese wamid es lo que despues llega en los
// webhooks de "statuses" (sent/delivered/read) y es la unica forma de saber a cual mensaje
// puntual de la conversacion corresponde cada check. Los mensajes del bot arrancan en estado
// "enviado"; los del cliente no llevan estado (WhatsApp no le muestra "vistos" a uno mismo).
function registrarMensaje(telefono, rol, texto) {
        const sesion = obtenerSesion(telefono);
        const registro = { rol, texto, fecha: new Date().toISOString() };
        if (rol === "bot") registro.estado = "enviado";
        sesion.transcripcion.push(registro);
        if (sesion.transcripcion.length > 200) {
                  sesion.transcripcion = sesion.transcripcion.slice(-200);
        }
        return registro;
}

// Jerarquia de estados de un mensaje saliente, igual que los "checks" de WhatsApp: enviado (1
// check) -> entregado (2 checks grises) -> leido (2 checks azules). fallido es aparte. Los
// webhooks de "statuses" no siempre llegan en orden perfecto, asi que al actualizar un mensaje
// nunca se debe "retroceder" el estado (por ejemplo, un "delivered" tardio que llega despues de
// que ya sabiamos que lo leyo no debe hacerlo volver a mostrar solo 2 checks grises).
const RANGO_ESTADO_MENSAJE = { enviado: 1, entregado: 2, leido: 3, fallido: 0 };

function escaparHtml(texto) {
        return String(texto || "").replace(/[&<>"']/g, (c) => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
        }[c]));
}

function formatearPrecio(numero) {
        return numero.toLocaleString("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 });
}

// Devuelve el "check" estilo WhatsApp para un mensaje que nosotros enviamos (rol "bot"), segun
// su estado guardado por marcarEstadoMensaje(): 1 palomita gris = enviado, 2 palomitas gris =
// entregado, 2 palomitas azules = leido, "!" rojo = fallo el envio. Los mensajes guardados antes
// de este feature no tienen "estado", asi que se muestran como "enviado" por defecto.
function iconoEstadoMensaje(estado) {
      if (estado === "leido") return '<span class="check check-leido" title="Leido">&#10003;&#10003;</span>';
      if (estado === "entregado") return '<span class="check" title="Entregado">&#10003;&#10003;</span>';
      if (estado === "fallido") return '<span class="check check-fallido" title="No se pudo entregar">&#33;</span>';
      return '<span class="check" title="Enviado">&#10003;</span>';
}

function formatearFechaHora(fechaIso) {
        if (!fechaIso) return "-";
        return new Date(fechaIso).toLocaleString("es-CO", {
                timeZone: "America/Bogota",
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
        });
}

async function enviarTexto(telefono, texto) {
      const registro = registrarMensaje(telefono, "bot", texto);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "text",
                  text: { body: texto },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

// Envia la plantilla de marketing "reactivacion_cliente_galviustech" (aprobada por Meta el 15
// sep 2026, categoria Marketing, idioma Spanish (COL)). A diferencia de enviarTexto (que solo
// funciona si el cliente escribio en las ultimas 24h), una plantilla SI le puede llegar a
// cualquier cliente sin importar cuanto tiempo lleve sin escribir - por eso se usa aqui para que
// la reactivacion le llegue de verdad a "todos" los clientes pendientes, no solo a los que
// escribieron hoy. El cuerpo aprobado es exactamente:
// "Hola {{1}} 👋 Soy Michell, de GalviusTech. Vi que te interesó nuestro {{2}} y no quise
// dejarte sin respuesta. ¿Seguimos con tu pedido, o tienes alguna duda? Escríbeme y te ayudo."
// Si cambia el nombre o el idioma de la plantilla en el Administrador de WhatsApp, hay que
// actualizar esos mismos valores aqui.
async function enviarPlantillaReactivacion(telefono, nombreCliente, nombreProducto) {
      const registro = registrarMensaje(
            telefono,
            "bot",
            `[Plantilla reactivacion_cliente_galviustech] Hola ${nombreCliente}, sobre ${nombreProducto}`
            );
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "template",
                  template: {
                        name: "reactivacion_cliente_galviustech",
                        language: { code: "es_CO" },
                        components: [
                              {
                                    type: "body",
                                    parameters: [
                                          { type: "text", text: nombreCliente },
                                          { type: "text", text: nombreProducto },
                                    ],
                              },
                        ],
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function enviarImagen(telefono, urlImagen, caption) {
      const registro = registrarMensaje(telefono, "bot", `[Imagen] ${caption || ""}`);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "image",
                  image: { link: urlImagen, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function enviarVideo(telefono, urlVideo, caption) {
      const registro = registrarMensaje(telefono, "bot", `[Video] ${caption || ""}`);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "video",
                  video: { link: urlVideo, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function subirMediaWhatsApp(buffer, mimetype) {
      const formData = new FormData();
      formData.append("messaging_product", "whatsapp");
      formData.append("file", new Blob([buffer], { type: mimetype }));
      const respuesta = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
            method: "POST",
            headers: { Authorization: `Bearer ${META_TOKEN}` },
            body: formData,
      });
      const datos = await respuesta.json();
      if (!datos.id) {
            const detalle = datos?.error?.error_data?.details || datos?.error?.message || JSON.stringify(datos);
            const error = new Error("No se pudo subir el archivo a WhatsApp: " + detalle);
            if (/demasiado grande/i.test(detalle)) {
                  error.esMensajeAmigable = true;
                  error.message = "El archivo es demasiado pesado para WhatsApp (imagenes hasta 5 MB, videos hasta 16 MB). Comprimelo o envia uno mas liviano.";
            }
            throw error;
      }
      return datos.id;
}

async function enviarImagenPorId(telefono, mediaId, caption) {
      const registro = registrarMensaje(telefono, "bot", `[Imagen] ${caption || ""}`);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "image",
                  image: { id: mediaId, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function enviarVideoPorId(telefono, mediaId, caption) {
      const registro = registrarMensaje(telefono, "bot", `[Video] ${caption || ""}`);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "video",
                  video: { id: mediaId, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function enviarBotones(telefono, texto, botones) {
      const listaBotones = botones.map((b) => b.titulo).join(" | ");
      const registro = registrarMensaje(telefono, "bot", `${texto}\n[Opciones: ${listaBotones}]`);
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "interactive",
                  interactive: {
                        type: "button",
                        body: { text: texto },
                        action: {
                              buttons: botones.map((b) => ({
                                    type: "reply",
                                    reply: { id: b.id, title: b.titulo },
                              })),
                        },
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function enviarListaCatalogo(telefono) {
      const registro = registrarMensaje(telefono, "bot", "[Envio el catalogo de productos]");
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "interactive",
                  interactive: {
                        type: "list",
                        header: { type: "text", text: `Catalogo ${config.nombreNegocio}` },
                        body: { text: "Estos son nuestros productos disponibles. Toca uno para ver mas detalles" },
                        action: {
                              button: "Ver productos",
                              sections: [
                                    {
                                          title: "Productos",
                                          rows: catalogo
                                                .filter((p) => !p.id.startsWith("combo-"))
                                                .map((p) => ({
                                                      id: `producto_${p.id}`,
                                                      title: p.nombreCorto || p.nombre,
                                                      description: formatearPrecio(p.precio),
                                                })),
                                    },
                                    ],
                        },
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

// Metadata de las categorias de producto que el catalogo puede tener. Nueva
// categoria = agregar aqui (opcional: si no esta aqui, igual funciona con
// valores por defecto en infoCategoria()).
const CATEGORIA_INFO = {
      modem: {
            titulo: "Modem Portatiles",
            emoji: "📶",
            palabras: ["modem", "módem", "internet", "wifi", "wi-fi"],
            resumen:
                  "*Nuestro Modem WiFi Portatil*\n\n" +
                  "Compatible con SIM de todos los operadores en Colombia (Claro, Movistar, Tigo, WOM, ETB)\n" +
                  "Conecta hasta 10 dispositivos al mismo tiempo\n" +
                  "Instalacion facil: insertas la SIM, enciendes y listo\n" +
                  "Bateria recargable\n" +
                  "Ideal para hogar, oficina, estudio, viajes y zonas rurales con cobertura movil\n" +
                  "Garantia de 30 dias y soporte de GalviusTech",
            pregunta: "Para recomendarte el modem ideal, cuentame: lo necesitas para una zona rural (vereda) o para la ciudad? Y en que ciudad o municipio estas?",
            // Variante que se muestra de entrada (1 sola foto) cuando la categoria tiene
            // varias variantes con precios distintos. Ver nota en enviarInfoCategoria: antes
            // se mandaban las 3 fotos del modem (4G, 4G/5G y 5G) con sus 3 precios de una vez,
            // lo cual abrumaba al cliente apenas entraba. El 4G/5G es la opcion "segura" que
            // funciona tanto en zonas con solo 4G como en zonas con 5G.
            variantePorDefecto: "modem-4g5g",
      },
      impresora: {
            titulo: "IMPRESORA TERMICA",
            emoji: "🖨️",
            palabras: ["impresora", "imprimir"],
            resumen: null,
            pregunta: "Cuentame, para que la necesitas: negocio, tienda, restaurante, domicilios u otro uso? Y en que ciudad estas?",
      },
      lampara: {
            titulo: "Lamparas Solares",
            emoji: "💡",
            palabras: ["lampara", "lámpara", "linterna", "panel solar", "luz solar"],
            resumen: null,
            pregunta: "Cuentame, la necesitas para tu casa, finca o negocio? Y en que ciudad estas?",
      },
      camara: {
            titulo: "Camara de Seguridad",
            emoji: "📹",
            palabras: ["camara", "cámara", "vigilancia", "seguridad"],
            resumen: null,
            pregunta: "Cuentame, la necesitas para tu casa, finca o negocio? Y en que ciudad estas?",
      },
};

function infoCategoria(categoria) {
      return (
            CATEGORIA_INFO[categoria] || {
                  titulo: categoria.charAt(0).toUpperCase() + categoria.slice(1),
                  emoji: "🛒",
                  palabras: [categoria],
                  resumen: null,
                  pregunta: "Cuentame, para que lo necesitas? Y en que ciudad estas?",
            }
      );
}

// Devuelve las categorias con al menos un producto (no combo), en el orden
// en que aparecen en el catalogo. Se recalcula siempre a partir de catalogo,
// asi que un producto nuevo que ella agregue en /admin/productos aparece
// automaticamente aqui apenas tenga una categoria asignada.
function categoriasDisponibles() {
      const vistas = new Set();
      const lista = [];
      for (const p of catalogo) {
            if (p.id.startsWith("combo-")) continue;
            const cat = (p.categoria || "").trim().toLowerCase();
            if (!cat || vistas.has(cat)) continue;
            vistas.add(cat);
            lista.push(cat);
      }
      return lista;
}

async function enviarInfoCategoria(telefono, categoria) {
      const sesion = obtenerSesion(telefono);
      const productos = catalogo.filter(
            (p) => !p.id.startsWith("combo-") && (p.categoria || "").trim().toLowerCase() === categoria
      );
      if (productos.length === 0) {
            await manejarSaludo(telefono, null);
            return;
      }
      // Se guarda la categoria aunque haya varias variantes (ej. los 3 modems) y todavia no
      // sepamos cual especifica quiere. Sin esto, si el cliente no llega a decir cual variante
      // le interesa y luego responde algo corto como "precio" o "este", el sistema no tenia
      // ningun producto/categoria que pasarle a la IA como contexto, y esta terminaba
      // pidiendole que repitiera el nombre del producto en vez de responder directo.
      sesion.ultimaCategoria = categoria;
      const info = infoCategoria(categoria);
      registrarMensaje(telefono, "bot", `[Envio fotos y caracteristicas: ${info.titulo}]`);

      // Cuando la categoria tiene varias variantes con precios distintos (ej. los 3 modems:
      // 4G, 4G/5G y 5G) y ademas define un resumen general (o sea, no son productos que se
      // vendan de a uno sino "versiones" de lo mismo), mandar las 3 fotos con sus 3 precios de
      // una sola vez apenas el cliente entra lo empuja a comparar precio en frio en vez de
      // conversar. En su lugar mostramos 1 sola foto generica + las caracteristicas comunes, y
      // dejamos que la pregunta de descubrimiento (abajo) y la conversacion con la IA lleven a
      // recomendar la variante puntual mas adelante (la IA la marca con PRODUCTO_ACTUAL).
      const esVariantesConResumen = productos.length > 1 && info.resumen;
      if (esVariantesConResumen) {
            const destacado = productos.find((p) => p.id === info.variantePorDefecto) || productos[0];
            if (destacado.imagenes && destacado.imagenes[0]) {
                  await enviarImagen(telefono, destacado.imagenes[0], info.titulo);
            }
            await enviarTexto(telefono, info.resumen);
            // ANCLA DE PRECIO (sep-2026): antes esta categoria (ej. modem, con 3 versiones) no
            // mostraba NINGUN precio hasta despues de la pregunta de descubrimiento, a proposito,
            // para no empujar al cliente a comparar precio en frio (ver nota arriba). Pero el
            // estudio del embudo de ventas mostro que ESE es, con diferencia, el punto donde mas
            // clientes desaparecen: preguntan y se van sin saber siquiera el precio aproximado.
            // Ahora se manda un precio "desde" de una vez (sin los 3 precios completos, para
            // seguir sin invitar a comparar en frio) como ancla, antes de la pregunta.
            const precios = productos.map((p) => p.precio).filter((n) => typeof n === "number").sort((a, b) => a - b);
            if (precios.length > 0) {
                  const precioDesde = precios[0];
                  const precioHasta = precios[precios.length - 1];
                  const lineaPrecio =
                        precioDesde === precioHasta
                              ? `Precio: ${formatearPrecio(precioDesde)}`
                              : `Precio desde ${formatearPrecio(precioDesde)} (tenemos varias versiones, te recomiendo la que mejor te sirva segun tu caso)`;
                  await enviarTexto(telefono, lineaPrecio);
            }
      } else {
            for (const p of productos) {
                  if (p.imagenes && p.imagenes[0]) {
                        await enviarImagen(telefono, p.imagenes[0], `${p.nombreCorto || p.nombre} - ${formatearPrecio(p.precio)}`);
                  }
            }

            if (productos.length === 1) {
                  const p = productos[0];
                  sesion.ultimoProducto = p.id;
                  await enviarTexto(telefono, `*${p.nombre}*\n${formatearPrecio(p.precio)}\n\n${p.descripcion || ""}`.trim());
            } else if (info.resumen) {
                  await enviarTexto(telefono, info.resumen);
            } else {
                  const lineas = productos.map((p) => `*${p.nombreCorto || p.nombre}* - ${formatearPrecio(p.precio)}`).join("\n");
                  await enviarTexto(telefono, `*${info.emoji} ${info.titulo}*\n\n${lineas}`);
            }
      }

      await enviarTexto(telefono, info.pregunta);
}


const OFERTAS_COMBO_POR_CATEGORIA = {
      modem: ["combo-modem-wifi-reloj-inteligente", "combo-modem-wifi-camara-de-seguridad"],
      impresora: ["combo-impresora-termica-portatil-camara-de-seguridad", "combo-impresora-termica-portatil-reloj"],
};

// WhatsApp limita el titulo de los botones a 20 caracteres, por eso usamos
// etiquetas cortas propias en vez del nombreCorto completo del catalogo.
const ETIQUETAS_BOTON_COMBO = {
      "combo-modem-wifi-reloj-inteligente": "Con reloj de regalo",
      "combo-modem-wifi-camara-de-seguridad": "Con camara de regalo",
      "combo-impresora-termica-portatil-camara-de-seguridad": "Con camara de regalo",
      "combo-impresora-termica-portatil-reloj": "Con reloj de regalo",
};

function etiquetaBotonCombo(combo) {
      return ETIQUETAS_BOTON_COMBO[combo.id] || (combo.nombreCorto || combo.nombre || "Ver oferta").slice(0, 20);
}

async function ofrecerComboPromocion(telefono, productoIdOriginal) {
      const productoBase = catalogo.find((p) => p.id === productoIdOriginal);
      const categoria = (productoBase?.categoria || "").trim().toLowerCase();
      const idsCombo = OFERTAS_COMBO_POR_CATEGORIA[categoria] || [];
      const combos = idsCombo.map((id) => catalogo.find((p) => p.id === id)).filter(Boolean);

      if (combos.length === 0) {
            await iniciarPedido(telefono, productoIdOriginal);
            return;
      }

      await enviarTexto(telefono, "Antes de confirmar tu pedido... 🎁 Por tiempo limitado puedes llevar:");

      for (const combo of combos) {
            // Cada combo manda primero sus fotos (todas, no solo la primera: con 1 sola foto muchas
            // veces solo se alcanza a ver el producto principal y el regalo del combo queda
            // invisible) y JUSTO DESPUES su propio nombre y precio, para que quede clarisimo a cual
            // combo pertenecen esas fotos, en vez de mandar todas las fotos de todos los combos
            // primero y despues un solo resumen junto al final (ahi se pierde cual foto era de cual).
            for (const url of combo.imagenes || []) {
                  await enviarImagen(telefono, url, combo.nombreCorto);
            }
            await enviarTexto(telefono, `🎁 *${combo.nombre}* por solo ${formatearPrecio(combo.precio)}`);
      }

      await enviarTexto(telefono, "Te animas a aprovechar alguna promocion?");

      const botones = combos.map((combo) => ({
            id: `combo_${combo.id}_${productoIdOriginal}`,
            titulo: etiquetaBotonCombo(combo),
            }));
      botones.push({
            id: `pedirfinal_${productoIdOriginal}`,
            titulo: "No, gracias",
            });
      await enviarBotones(telefono, "Que prefieres?", botones);
}

function estaEnHorarioComercial() {
      const ahoraUtc = new Date();
      const horaBogota = (ahoraUtc.getUTCHours() - 5 + 24) % 24;
      return horaBogota >= 6 && horaBogota < 20;
}

function imagenesPromoParaProducto(productoId) {
      const productoBase = productoId ? catalogo.find((p) => p.id === productoId) : null;
      const categoria = (productoBase?.categoria || "").trim().toLowerCase();
      let combos = (OFERTAS_COMBO_POR_CATEGORIA[categoria] || [])
            .map((id) => catalogo.find((p) => p.id === id))
            .filter((c) => c && c.imagenes && c.imagenes[0]);
      if (combos.length === 0) {
            combos = catalogo.filter((p) => p.id.startsWith("combo-") && p.imagenes && p.imagenes[0]);
      }
      return combos.slice(0, 2);
}

function detectarPreguntaUso(texto) {
      const t = texto.toLowerCase();
      return (
            t.includes("como funciona") ||
            t.includes("cómo funciona") ||
            t.includes("como se usa") ||
            t.includes("cómo se usa") ||
            t.includes("modo de uso") ||
            t.includes("como lo uso") ||
            t.includes("como instalo") ||
            t.includes("como instalar") ||
            t.includes("instalacion") ||
            t.includes("instalación") ||
            t.includes("como lo prendo") ||
            t.includes("como lo enciendo") ||
            t.includes("como conecto") ||
            t.includes("como configuro") ||
            t.includes("manual") ||
            t.includes("tutorial")
            );
}

async function enviarModoDeUso(telefono) {
      const sesion = obtenerSesion(telefono);
      const productoId = sesion.pedido?.productoId || sesion.ultimoProducto || null;
      const producto = productoId ? catalogo.find((p) => p.id === productoId) : null;
      const esImpresora = productoId === "impresora-termica";

if (producto && producto.video) {
      await enviarVideo(telefono, producto.video, "Como funciona");
} else if (!esImpresora) {
      const modemConVideo = catalogo.find((p) => p.id.startsWith("modem") && p.video);
      if (modemConVideo) {
            await enviarVideo(telefono, modemConVideo.video, "Como funciona (modelo similar)");
      }
}

const instrucciones = esImpresora
      ? "📖 *Modo de uso*\n\n1. Carga la impresora con el cable USB incluido.\n2. Enciende el boton de encendido (se prende una luz).\n3. Abre la tapa e inserta el rollo de papel termico (sin tinta).\n4. Activa el Bluetooth en tu celular y busca el nombre de la impresora para emparejarla.\n5. Descarga la app recomendada y selecciona la impresora.\n6. Listo, ya puedes imprimir facturas, recibos y mas desde tu celular!"
      : "📖 *Modo de uso*\n\n1. Abre la tapa trasera y coloca la SIM Card (como la de tu celular).\n2. Cierra la tapa y manten presionado el boton de encendido unos segundos.\n3. Espera a que la pantalla muestre senal y la palabra WiFi.\n4. En tu celular o computador, busca la red WiFi que aparece en la pantalla del modem o en la etiqueta de atras.\n5. Ingresa la contrasena que tambien viene en la etiqueta de atras del equipo.\n6. Listo, ya tienes internet portatil donde quieras!\n\nLa bateria dura varias horas y se carga por cable USB-C.";

await enviarTexto(telefono, instrucciones);
}

function detectarPreguntaFotos(texto) {
      const t = texto.toLowerCase();
      return (
            t.includes("foto") ||
            t.includes("imagen") ||
            t.includes("imágen") ||
            t.includes("como se ve") ||
            t.includes("cómo se ve") ||
            t.includes("muestrame") ||
            t.includes("muéstrame") ||
            t.includes("mandame") ||
            t.includes("mándame") ||
            t.includes("enviame") ||
            t.includes("envíame") ||
            t.includes("pasame") ||
            t.includes("pásame")
            );
}

async function enviarFotosProducto(telefono, texto) {
      const sesion = obtenerSesion(telefono);

      const especifico = detectarProductoEspecifico(texto);
      const categoriaMencionada = detectarProductoPorPalabraClave(texto);
      const productoIdSesion = sesion.pedido?.productoId || sesion.ultimoProducto || null;

      let productos = [];
      let unSoloProducto = false;

      if (especifico) {
            const p = catalogo.find((prod) => prod.id === especifico);
            if (p) {
                  productos = [p];
                  unSoloProducto = true;
            }
      } else if (categoriaMencionada) {
            productos = catalogo.filter(
                  (p) => !p.id.startsWith("combo-") && (p.categoria || "").trim().toLowerCase() === categoriaMencionada
                  );
      } else if (productoIdSesion) {
            const p = catalogo.find((prod) => prod.id === productoIdSesion);
            if (p) {
                  productos = [p];
                  unSoloProducto = true;
            }
      }

      const conFotos = productos.filter((p) => p.imagenes && p.imagenes.length > 0);

      if (conFotos.length === 0) {
            await enviarTexto(
                  telefono,
                  "Claro que si! Cuentame de cual producto quieres ver fotos: modem, impresora, lampara o camara?"
                  );
            return;
      }

      registrarMensaje(telefono, "bot", "[Envio fotos solicitadas]");
      for (const p of conFotos) {
            const urls = unSoloProducto || conFotos.length === 1 ? p.imagenes : [p.imagenes[0]];
            for (const url of urls) {
                  await enviarImagen(telefono, url, p.nombreCorto || p.nombre);
            }
      }
      await enviarTexto(telefono, "Ahi tienes las fotos! Te cuento mas detalles o seguimos con tu pedido?");
}

async function leerJSON(url) {
      try {
            const respuesta = await axios.get(url, {
                  headers: { Authorization: `token ${GITHUB_TOKEN}` },
            });
            let contenido;
            if (respuesta.data && respuesta.data.content) {
                  contenido = Buffer.from(respuesta.data.content, "base64").toString("utf-8");
            } else {
                  // Archivos mayores a 1MB: la API de contenidos de GitHub no incluye "content" en este caso,
                  // asi que se pide el contenido crudo del archivo por separado (funciona hasta 100MB).
                  const respuestaCruda = await axios.get(url, {
                        headers: {
                              Authorization: `token ${GITHUB_TOKEN}`,
                              Accept: "application/vnd.github.raw",
                        },
                        responseType: "text",
                        transformResponse: (data) => data,
                  });
                  contenido = respuestaCruda.data;
            }
            return { datos: JSON.parse(contenido), sha: respuesta.data.sha };
      } catch (error) {
            if (error.response?.status === 404) {
                  return { datos: [], sha: null };
            }
            throw error;
      }
}

async function guardarJSON(url, datos, sha, mensaje) {
      const contenidoNuevo = Buffer.from(JSON.stringify(datos, null, 2)).toString("base64");
      await axios.put(
            url,
            {
                  message: mensaje,
                  content: contenidoNuevo,
                  sha: sha || undefined,
            },
            { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
            );
}

// Cola de escritura por archivo (clientes.json / pedidos.json): cada actualizacion hace su propio
// ciclo "leer -> modificar -> guardar" contra la API de GitHub, que solo permite un commit a la vez
// por archivo (usa el sha como control de version). Antes, cuando dos de esas actualizaciones se
// disparaban casi al mismo tiempo (por ejemplo: llega el webhook de "leido" de un mensaje justo
// cuando el recordatorio automatico tambien esta guardando, o dos clientes escriben a la vez), las
// dos leian el mismo sha, la primera en guardar ganaba y la segunda chocaba con un error 409/422.
// Cada funcion reintentaba unas pocas veces (leyendo de nuevo), pero con tantas funciones tocando
// el mismo archivo (guardarCliente, marcarEstadoMensaje, recordatorios, promo diaria, limpieza,
// reactivacion, etc.) - y ahora ademas con los recordatorios y la promo corriendo tambien por
// reloj (setInterval) y no solo cuando llega un mensaje - a veces se agotaban los reintentos y la
// actualizacion se perdia en silencio. Esa perdida silenciosa fue la causa real de que el estado
// "leido" (los chulos azules) casi nunca quedara guardado de forma permanente: WhatsApp SI avisaba
// que el cliente habia leido el mensaje, pero la escritura a clientes.json chocaba y se descartaba.
// Esta cola obliga a que todas las operaciones sobre el MISMO archivo se hagan una por una, en
// orden, para que cada una lea siempre la version mas reciente y practicamente nunca choque consigo
// misma (dentro de este mismo proceso).
const colasEscrituraPorArchivo = new Map();
function conColaDeArchivo(url, tarea) {
      const anterior = colasEscrituraPorArchivo.get(url) || Promise.resolve();
      const actual = anterior.then(tarea, tarea);
      // Si "tarea" fallo, guardamos una version ya "atrapada" en el mapa para que el siguiente en
      // la fila no se quede esperando una promesa rechazada (pero el error real se sigue
      // propagando a quien llamo esta vez, mas abajo con "return actual").
      colasEscrituraPorArchivo.set(url, actual.catch(() => {}));
      return actual;
}

// Cola en memoria por numero de telefono (diagnostico sep-2026): cuando un mismo cliente manda
// varios mensajes de WhatsApp seguidos y muy rapido (algo comun: la gente escribe en varios
// mensajitos cortos en vez de uno solo), Meta manda un webhook POST distinto por cada uno, y este
// servidor los procesaba en paralelo. Dos llamadas a preguntarleALaIA para el MISMO cliente
// corriendo al tiempo pueden alternar sus pasos y dejar sesion.historial con dos mensajes "user"
// seguidos sin un "assistant" en medio (ej. si el mensaje B alcanza a empujarse al historial antes
// de que la respuesta de la IA para el mensaje A se haya guardado). La API de Anthropic exige que
// los roles alternen estrictamente, asi que en cuanto el historial queda asi, esa llamada (y muchas
// veces TODAS las siguientes con ese mismo cliente, porque el catch de preguntarleALaIA hace
// historial.pop() y a veces termina borrando la respuesta buena en vez de la entrada danada) fallan,
// y el cliente se queda viendo "Disculpa, tuve un problema para procesar tu mensaje" una y otra vez.
// Esta cola obliga a que los mensajes de un mismo numero se procesen uno por uno, en el orden en que
// llegaron, nunca en paralelo, eliminando la condicion de carrera de raiz.
const colasPorTelefono = new Map();
function conColaPorTelefono(telefono, tarea) {
      const anterior = colasPorTelefono.get(telefono) || Promise.resolve();
      const actual = anterior.then(tarea, tarea);
      colasPorTelefono.set(telefono, actual.catch(() => {}));
      return actual;
}

function actualizarCatalogoEnMemoria(nuevoCatalogo) {
      catalogo.length = 0;
      catalogo.push(...nuevoCatalogo);
}

function generarIdProducto(nombre, existentes) {
      const base = String(nombre || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-+|-+$)/g, "") || "producto";
      let id = base;
      let contador = 2;
      while (existentes.includes(id)) {
            id = `${base}-${contador}`;
            contador++;
      }
      return id;
}

function parsearPrecio(valor) {
      const limpio = String(valor || "").replace(/[^0-9]/g, "");
      return limpio ? parseInt(limpio, 10) : 0;
}

function parsearLineas(texto) {
      return String(texto || "")
            .split("\n")
            .map((linea) => linea.trim())
            .filter(Boolean);
}

// CRITICO: a diferencia de guardarCliente/marcarRecordatoriosEnviados/marcarPromoDiariaEnviada,
// esta funcion NO reintentaba si otra escritura simultanea a pedidos.json dejaba el "sha" viejo
// (error 409/422) - simplemente lo registraba en consola y se rendia, perdiendo el pedido EN
// SILENCIO. Esto le paso de verdad a Jose Gabriel Diaz Gutierrez (584261736349, "venta de chimo al
// detal"): el bot le confirmo "tu pedido queda completo", pero el pedido nunca quedo guardado en
// pedidos.json. Ahora reintenta igual que las demas funciones, y devuelve true/false para que quien
// llama sepa si de verdad quedo guardado antes de confirmarle al cliente que todo esta listo.
async function guardarPedido(pedido) {
      let exito = false;
      await conColaDeArchivo(PEDIDOS_API, async () => {
      let intentosRestantes = 4;
      while (true) {
      try {
            const { datos, sha } = await leerJSON(PEDIDOS_API);
            datos.unshift({ ...pedido, fecha: new Date().toISOString() });
            await guardarJSON(PEDIDOS_API, datos, sha, "Nuevo pedido registrado");
            exito = true;
            return;
      } catch (error) {
            const esConflicto = error.response?.status === 409 || error.response?.status === 422;
            if (esConflicto && intentosRestantes > 0) {
                  intentosRestantes--;
                  continue;
            }
            console.error("Error guardando pedido:", error.response?.data || error.message);
            return;
      }
      }
      });
      return exito;
}

async function guardarCliente(telefono, nombreCliente) {
      await conColaDeArchivo(CLIENTES_API, async () => {
      let intentosRestantes = 4;
      while (true) {
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const ahora = new Date().toISOString();
            const sesion = obtenerSesion(telefono);
            const existente = datos.find((c) => c.telefono === telefono);

      if (existente) {
            existente.ultimoContacto = ahora;
            if (nombreCliente) existente.nombre = nombreCliente;
            existente.mensajes = (existente.mensajes || 1) + 1;
            existente.conversacion = sesion.transcripcion;
            existente.paso = sesion.paso;
            existente.pedido = sesion.pedido;
            existente.pausado = !!sesion.pausado;
            existente.ultimoProducto = sesion.pedido?.productoId || sesion.ultimoProducto || existente.ultimoProducto || null;
            existente.ultimaCategoria = sesion.ultimaCategoria || existente.ultimaCategoria || null;
            existente.necesitaAtencion = !!sesion.necesitaAtencion;
            existente.motivoAtencion = sesion.necesitaAtencion ? (sesion.motivoAtencion || null) : null;
            existente.pausarSeguimiento = !!sesion.pausarSeguimiento || !!existente.pausarSeguimiento;
            if (existente.etapaManual === undefined) existente.etapaManual = null;
      } else {
            datos.unshift({
                  telefono,
                  nombre: nombreCliente || "",
                  primerContacto: ahora,
                  ultimoContacto: ahora,
                  mensajes: 1,
                  conversacion: sesion.transcripcion,
                  paso: sesion.paso,
                  pedido: sesion.pedido,
                  pausado: !!sesion.pausado,
                  etapaManual: null,
                  ultimoProducto: sesion.pedido?.productoId || sesion.ultimoProducto || null,
                  ultimaCategoria: sesion.ultimaCategoria || null,
                  necesitaAtencion: !!sesion.necesitaAtencion,
                  motivoAtencion: sesion.necesitaAtencion ? (sesion.motivoAtencion || null) : null,
                  pausarSeguimiento: !!sesion.pausarSeguimiento,
            });
      }

      await guardarJSON(CLIENTES_API, datos, sha, "Registro de cliente actualizado");
      return;
      } catch (error) {
            // Conflicto: otra escritura guardo clientes.json al mismo tiempo y el sha con el que
            // leimos quedo desactualizado. Reintentamos leyendo la version mas reciente en vez de
            // perder esta actualizacion del cliente (mismo patron que los recordatorios). Con la
            // cola de arriba esto ya casi no deberia pasar dentro de este mismo proceso, pero se
            // deja como respaldo por si la escritura choca con algo externo.
            const esConflicto = error.response?.status === 409 || error.response?.status === 422;
            if (esConflicto && intentosRestantes > 0) {
                  intentosRestantes--;
                  continue;
            }
            console.error("Error guardando cliente:", error.response?.data || error.message);
            return;
      }
      }
      });
}

// Actualiza el estado de un mensaje ya enviado (enviado -> entregado -> leido) cuando llega el
// webhook de "statuses" de Meta. Usa RANGO_ESTADO_MENSAJE para que un evento atrasado (ej. un
// "delivered" que llega despues de que ya se registro "read") nunca retroceda el estado mostrado.
async function marcarEstadoMensaje(telefono, wamid, nuevoEstado) {
      if (!telefono || !wamid) return;
      // Actualiza primero la sesion en memoria: es lo que ve el panel si esta conversacion ya
      // esta cargada, sin tener que esperar a la lectura/escritura de clientes.json.
      const sesion = sesiones[telefono];
      if (sesion?.transcripcion) {
            const msjMemoria = sesion.transcripcion.find((m) => m.wamid === wamid);
            if (msjMemoria && (RANGO_ESTADO_MENSAJE[nuevoEstado] || 0) > (RANGO_ESTADO_MENSAJE[msjMemoria.estado] || 0)) {
                  msjMemoria.estado = nuevoEstado;
            }
      }
      await conColaDeArchivo(CLIENTES_API, async () => {
      let intentosRestantes = 4;
      while (true) {
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const cliente = datos.find((c) => c.telefono === telefono);
            const msj = cliente?.conversacion?.find((m) => m.wamid === wamid);
            if (!msj) return;
            if ((RANGO_ESTADO_MENSAJE[nuevoEstado] || 0) <= (RANGO_ESTADO_MENSAJE[msj.estado] || 0)) return;
            msj.estado = nuevoEstado;
            await guardarJSON(CLIENTES_API, datos, sha, "Estado de mensaje actualizado");
            return;
      } catch (error) {
            const esConflicto = error.response?.status === 409 || error.response?.status === 422;
            if (esConflicto && intentosRestantes > 0) {
                  intentosRestantes--;
                  continue;
            }
            console.error("Error actualizando estado de mensaje:", error.response?.data || error.message);
            return;
      }
      }
      });
}

async function alternarPausa(telefono) {
      return await conColaDeArchivo(CLIENTES_API, async () => {
      const { datos, sha } = await leerJSON(CLIENTES_API);
      const cliente = datos.find((c) => c.telefono === telefono);
      if (!cliente) return null;
      cliente.pausado = !cliente.pausado;
      await guardarJSON(CLIENTES_API, datos, sha, "Pausa de bot actualizada");
      if (sesiones[telefono]) {
            sesiones[telefono].pausado = cliente.pausado;
      }
      return cliente.pausado;
      });
}

async function alternarEtapa(telefono, etapa) {
      await conColaDeArchivo(CLIENTES_API, async () => {
      const { datos, sha } = await leerJSON(CLIENTES_API);
      const cliente = datos.find((c) => c.telefono === telefono);
      if (!cliente) return;
      cliente.etapaManual = etapa === "auto" ? null : etapa;
      await guardarJSON(CLIENTES_API, datos, sha, "Etapa de cliente actualizada");
      });
}

// Quita a un cliente de la casilla de "Necesitan tu respuesta" sin necesidad de escribirle
// (por si Wendy ya lo resolvio por fuera del panel, o solo quiere descartar el aviso).
async function marcarAtencionResuelta(telefono) {
      await conColaDeArchivo(CLIENTES_API, async () => {
      const { datos, sha } = await leerJSON(CLIENTES_API);
      const cliente = datos.find((c) => c.telefono === telefono);
      if (!cliente) return;
      cliente.necesitaAtencion = false;
      cliente.motivoAtencion = null;
      await guardarJSON(CLIENTES_API, datos, sha, "Aviso de atencion resuelto");
      if (sesiones[telefono]) {
            sesiones[telefono].necesitaAtencion = false;
            sesiones[telefono].motivoAtencion = null;
      }
      });
}

async function enviarMensajeManual(telefono, texto) {
      await cargarSesionSiNueva(telefono);
      const sesion = obtenerSesion(telefono);
      sesion.pausado = true;
      // Wendy ya esta respondiendo este chat personalmente, asi que deja de aparecer
      // en la casilla de "necesitan tu respuesta".
      sesion.necesitaAtencion = false;
      sesion.motivoAtencion = null;
      await enviarTexto(telefono, texto);
      await guardarCliente(telefono);
}

// Limites reales de WhatsApp para adjuntos (mas alla de esto, la API de Meta los rechaza).
const LIMITES_TAMANO_ARCHIVO = {
      imagen: 5 * 1024 * 1024,
      video: 16 * 1024 * 1024,
};

async function enviarArchivoManual(telefono, archivo, caption) {
      await cargarSesionSiNueva(telefono);
      const sesion = obtenerSesion(telefono);
      sesion.pausado = true;
      sesion.necesitaAtencion = false;
      sesion.motivoAtencion = null;

      if (archivo.mimetype.startsWith("image/") && archivo.size > LIMITES_TAMANO_ARCHIVO.imagen) {
            const error = new Error("La imagen pesa demasiado (maximo 5 MB en WhatsApp). Comprimela o envia una mas liviana.");
            error.esMensajeAmigable = true;
            throw error;
      }
      if (archivo.mimetype.startsWith("video/") && archivo.size > LIMITES_TAMANO_ARCHIVO.video) {
            const error = new Error("El video pesa demasiado (maximo 16 MB en WhatsApp). Comprimelo o envia uno mas liviano.");
            error.esMensajeAmigable = true;
            throw error;
      }

      const mediaId = await subirMediaWhatsApp(archivo.buffer, archivo.mimetype);
      if (archivo.mimetype.startsWith("image/")) {
            await enviarImagenPorId(telefono, mediaId, caption);
      } else if (archivo.mimetype.startsWith("video/")) {
            await enviarVideoPorId(telefono, mediaId, caption);
      } else {
            const error = new Error("Solo se permiten imagenes o videos.");
            error.esMensajeAmigable = true;
            throw error;
      }
      await guardarCliente(telefono);
}

function calcularEtapa(cliente, telefonosConPedido) {
      if (cliente.etapaManual) return cliente.etapaManual;
      if (cliente.pausado) return "No automatizado";
      if (telefonosConPedido.has(cliente.telefono)) return "Datos completados";
      const paso = cliente.paso || "inicio";
      if (paso.startsWith("pedido_") || paso === "esperando_confirmacion_envio") return "Cliente potencial";
      if (paso === "conversando" && (cliente.mensajes || 1) > 1) return "Interaccion con IA";
      return "Contacto inicial";
}

// Devuelve la categoria (ej. "modem", "impresora", "lampara") del ultimo
// producto por el que un cliente mostro interes, buscandolo en el catalogo.
// Si el cliente aun no ha mostrado interes por ningun producto especifico,
// devuelve null.
function categoriaDeInteresCliente(cliente) {
	const productoId = cliente.pedido?.productoId || cliente.ultimoProducto || null;
	if (!productoId) return null;
	const producto = catalogo.find((p) => p.id === productoId);
	if (!producto) return null;
	if (producto.id.startsWith("combo-")) return "combo";
	return (producto.categoria || "").trim().toLowerCase() || null;
}

function filtrarClientesPorCategoria(clientes, categoria) {
	if (!categoria || categoria === "todas") return clientes;
	return clientes.filter((c) => categoriaDeInteresCliente(c) === categoria);
}

function filtrarClientesPorFecha(clientes, filtro) {
	if (!filtro || filtro === "todos") return clientes;
	const ahora = new Date();
	const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
	const inicioAyer = new Date(inicioHoy);
	inicioAyer.setDate(inicioAyer.getDate() - 1);
	const hace7dias = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
	return clientes.filter((c) => {
		if (!c.ultimoContacto) return false;
		const fecha = new Date(c.ultimoContacto);
		if (filtro === "hoy") return fecha >= inicioHoy;
		if (filtro === "ayer") return fecha >= inicioAyer && fecha < inicioHoy;
		if (filtro === "7dias") return fecha >= hace7dias;
		return true;
	});
}

let ultimaLimpieza = 0;

async function limpiarClientesAntiguos() {
      const ahora = Date.now();
      if (ahora - ultimaLimpieza < 24 * 60 * 60 * 1000) return;
      ultimaLimpieza = ahora;
      await conColaDeArchivo(CLIENTES_API, async () => {
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
            const limiteMs = 3 * 24 * 60 * 60 * 1000;
            const cantidadOriginal = datos.length;
            const datosFiltrados = datos.filter((c) => {
                  // Los clientes que ya compraron no se borran nunca, sin importar cuanto lleven sin
                  // escribir: son historial de ventas real (y ademas quedarian sin pedido asociado
                  // en el panel), no leads sin convertir que ya no valga la pena conservar.
                  if (telefonosConPedido.has(c.telefono)) return true;
                  const ultimo = new Date(c.ultimoContacto).getTime();
                  if (isNaN(ultimo)) return true;
                  return ahora - ultimo <= limiteMs;
            });
            if (datosFiltrados.length !== cantidadOriginal) {
                  for (const telefono of Object.keys(sesiones)) {
                        const sigueExistiendo = datosFiltrados.some((c) => c.telefono === telefono);
                        if (!sigueExistiendo) delete sesiones[telefono];
                  }
                  await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Eliminados clientes con mas de 3 dias sin contacto");
            }
      } catch (error) {
            console.error("Error eliminando clientes antiguos:", error.response?.data || error.message);
      }
      });
}

async function preguntarleALaIA(sesion, mensajeCliente, enfoqueProducto) {
      sesion.historial.push({ role: "user", content: mensajeCliente });
      if (sesion.historial.length > 16) {
            sesion.historial = sesion.historial.slice(-16);
      }

let respuesta;
try {
      respuesta = await axios.post(
            ANTHROPIC_URL,
            {
                  model: ANTHROPIC_MODEL,
                  max_tokens: 700,
                  system: config.construirSystemPrompt(catalogo, enfoqueProducto),
                  messages: sesion.historial,
            },
            {
                  headers: {
                        "x-api-key": ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                  },
            }
            );
} catch (error) {
      // Si la llamada a la IA falla, sacamos del historial el mensaje del cliente que acabamos de
      // agregar. Si no lo hacemos, el historial queda con dos mensajes "user" seguidos, y la API de
      // Anthropic rechaza TODAS las llamadas siguientes con este mismo cliente (no solo esta),
      // causando que el bot responda "tuve un problema" a cada mensaje de ahi en adelante.
      sesion.historial.pop();
      throw error;
}

const bloques = respuesta.data.content || [];
      const textoCompleto = bloques
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

sesion.historial.push({ role: "assistant", content: textoCompleto });

let lineas = textoCompleto.split("\n");
      let productoId = null;
      let productoActual = null;
      let necesitaAsesor = false;
      let pausarSeguimiento = false;

      // La IA puede terminar su respuesta con hasta 4 lineas de control (nunca visibles para
      // el cliente, el sistema las procesa por separado): PRODUCTO_ACTUAL (que producto
      // especifico se esta hablando, para enviar fotos/videos correctos despues), ACCION_PEDIDO
      // (si el cliente ya confirmo que quiere comprar), NECESITA_ASESOR (si la IA no pudo
      // resolverle algo con seguridad al cliente) y PAUSAR_SEGUIMIENTO (si el cliente dijo
      // explicitamente que el mismo va a avisar despues, o que no le escriban mas por ahora).
      // No asumimos un orden fijo entre ellas: se van revisando desde la ultima linea hacia
      // atras hasta que una no coincida con ninguna.
      let siguioQuitando = true;
      while (siguioQuitando && lineas.length > 0) {
            siguioQuitando = false;
            const ultimaLinea = lineas[lineas.length - 1].trim();

            const matchPedido = ultimaLinea.match(/^ACCION_PEDIDO:\s*(\S+)/i);
            const matchProducto = ultimaLinea.match(/^PRODUCTO_ACTUAL:\s*(\S+)/i);
            const matchAsesor = ultimaLinea.match(/^NECESITA_ASESOR:\s*(\S+)/i);
            const matchPausar = ultimaLinea.match(/^PAUSAR_SEGUIMIENTO:\s*(\S+)/i);

            if (matchPedido && !productoId) {
                  productoId = matchPedido[1].trim();
                  lineas = lineas.slice(0, -1);
                  siguioQuitando = true;
            } else if (matchProducto && !productoActual) {
                  productoActual = matchProducto[1].trim();
                  lineas = lineas.slice(0, -1);
                  siguioQuitando = true;
            } else if (matchAsesor) {
                  necesitaAsesor = /^s[ií]$/i.test(matchAsesor[1].trim());
                  lineas = lineas.slice(0, -1);
                  siguioQuitando = true;
            } else if (matchPausar) {
                  pausarSeguimiento = /^s[ií]$/i.test(matchPausar[1].trim());
                  lineas = lineas.slice(0, -1);
                  siguioQuitando = true;
            }
      }

      const mensajeVisible = lineas.join("\n").trim();

return { mensajeVisible, productoId, productoActual, necesitaAsesor, pausarSeguimiento };
}

let ultimaRevisionRecordatorios = 0;
// Respaldo en memoria: aunque el guardado en clientes.json falle (por ejemplo por una escritura
// simultanea de otra conversacion), esto evita reenviar el mismo recordatorio al mismo cliente
// una y otra vez cada 10 minutos mientras el proceso siga corriendo.
const recordatoriosEnviadosEnProceso = new Set();

async function enviarRecordatoriosPendientes() {
      const ahora = Date.now();
      if (ahora - ultimaRevisionRecordatorios < 10 * 60 * 1000) return;
      ultimaRevisionRecordatorios = ahora;
      if (!estaEnHorarioComercial()) return;
      try {
            const { datos } = await leerJSON(CLIENTES_API);
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));

            const pendientes = [];
            for (const c of datos) {
                  if (c.pausado) continue;
                  // Si el cliente tiene un caso escalado pendiente de que Wendy responda,
                  // no le mandamos recordatorios automaticos de venta encima de eso.
                  if (c.necesitaAtencion) continue;
                  // Si el cliente ya dijo explicitamente "yo aviso" / "no insistas" (PAUSAR_SEGUIMIENTO),
                  // respetamos eso y no lo seguimos contactando automaticamente.
                  if (c.pausarSeguimiento) continue;
                  if (telefonosConPedido.has(c.telefono)) continue;
                  if (!c.ultimoContacto) continue;
                  const recordatorios = c.recordatorios || {};
                  const transcurrido = ahora - new Date(c.ultimoContacto).getTime();

                  let tier = null;
                  if (transcurrido >= 2 * 60 * 60 * 1000 && !recordatorios.horas2) tier = "horas2";
                  else if (transcurrido >= 5 * 60 * 60 * 1000 && !recordatorios.horas5) tier = "horas5";
                  else if (transcurrido >= 8 * 60 * 60 * 1000 && !recordatorios.horas8) tier = "horas8";
                  else if (transcurrido >= 11 * 60 * 60 * 1000 && !recordatorios.horas11) tier = "horas11";
                  if (!tier) continue;

                  if (recordatoriosEnviadosEnProceso.has(`${c.telefono}|${tier}`)) continue;
                  pendientes.push({ telefono: c.telefono, tier, productoId: c.pedido?.productoId || null, paso: c.paso || null });
            }

            for (const p of pendientes) {
                  const clave = `${p.telefono}|${p.tier}`;
                  try {
                        // CRITICO: si todavia no existe una sesion en memoria para este cliente (por
                        // ejemplo justo despues de que el servidor reinicio), hay que cargarla desde
                        // clientes.json ANTES de mandarle cualquier mensaje. Si no, el primer
                        // enviarTexto() de aqui abajo crea sin querer una sesion en blanco (via
                        // obtenerSesion), y esa sesion en blanco (paso "inicio", sin historial) le
                        // "gana" para siempre a la real: cuando el cliente responda, cargarSesionSiNueva
                        // ya no hace nada porque la sesion "ya existe", y el bot lo trata como si fuera
                        // nuevo (le manda el saludo genérico) y ademas termina SOBREESCRIBIENDO su
                        // conversacion guardada con la version en blanco la proxima vez que se guarde.
                        // Este fue el bug que le paso a Marbel Gutierrez Bustos (573171166841).
                        await cargarSesionSiNueva(p.telefono);
                        // Si el cliente se quedo A MITAD del flujo de pedido (ya dio varios de sus
                        // datos, ej. nombre/celular/ciudad, y solo falta uno o dos), un recordatorio
                        // generico de "sigues interesado" lo hace sentir que tiene que empezar de
                        // cero. Es mucho mas efectivo decirle exactamente cual es el unico dato que
                        // falta para despachar su pedido.
                        const definicionFaltante = p.paso
                              ? DEFINICIONES_CAMPOS_PEDIDO.find((d) => d.paso === p.paso)
                              : null;

                        if (definicionFaltante) {
                              await enviarTexto(
                                    p.telefono,
                                    config.mensajeRecordatorioPedidoPendiente(definicionFaltante.pregunta, p.tier)
                                    );
                              recordatoriosEnviadosEnProceso.add(clave);
                              continue;
                        }

                        const producto = p.productoId ? catalogo.find((prod) => prod.id === p.productoId) : null;
                        const nombreProducto = producto?.nombre || null;
                        const precioTexto = producto ? formatearPrecio(producto.precio) : null;

                        if (p.tier === "horas2") {
                              await enviarTexto(p.telefono, config.mensajeRecordatorio2Horas(nombreProducto, precioTexto));
                        } else if (p.tier === "horas5") {
                              await enviarTexto(p.telefono, config.mensajeRecordatorio5Horas(nombreProducto, precioTexto));
                              for (const combo of imagenesPromoParaProducto(p.productoId)) {
                                    await enviarImagen(p.telefono, combo.imagenes[0], combo.nombreCorto || combo.nombre);
                              }
                        } else if (p.tier === "horas8") {
                              await enviarTexto(p.telefono, config.mensajeRecordatorio8Horas(nombreProducto, precioTexto));
                        } else if (p.tier === "horas11") {
                              await enviarTexto(p.telefono, config.mensajeRecordatorio11Horas(nombreProducto, precioTexto));
                        }
                        recordatoriosEnviadosEnProceso.add(clave);
                  } catch (errorEnvio) {
                        console.error(`Error enviando recordatorio ${p.tier} a ${p.telefono}:`, errorEnvio.response?.data || errorEnvio.message);
                  }
            }

            if (pendientes.length > 0) {
                  await marcarRecordatoriosEnviados(pendientes);
            }
      } catch (error) {
            console.error("Error enviando recordatorios:", error.response?.data || error.message);
      }
}

// Guarda las banderas de recordatorios enviados directamente sobre la version MAS RECIENTE de
// clientes.json (no sobre la copia que se leyo al inicio), y reintenta si otra escritura
// simultanea invalido el sha. Asi no se pisan cambios que otra conversacion haya guardado mientras
// se enviaban los mensajes.
async function marcarRecordatoriosEnviados(pendientes) {
      await conColaDeArchivo(CLIENTES_API, async () => {
      let intentosRestantes = 4;
      while (true) {
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            let cambios = false;
            for (const p of pendientes) {
                  const cliente = datos.find((c) => c.telefono === p.telefono);
                  if (!cliente) continue;
                  if (!cliente.recordatorios) cliente.recordatorios = {};
                  if (!cliente.recordatorios[p.tier]) {
                        cliente.recordatorios[p.tier] = true;
                        cambios = true;
                  }
            }
            if (!cambios) return;
            await guardarJSON(CLIENTES_API, datos, sha, "Recordatorios de remarketing enviados");
            return;
      } catch (error) {
            const esConflicto = error.response?.status === 409 || error.response?.status === 422;
            if (esConflicto && intentosRestantes > 0) {
                  intentosRestantes--;
                  continue;
            }
            console.error(
                  "Error guardando banderas de recordatorios (los mensajes ya se enviaron; el respaldo en memoria evita que se repitan):",
                  error.response?.data || error.message
                  );
            return;
      }
      }
      });
}

// Promocion diaria "solo por hoy" para TODOS los clientes que aun no han comprado, segun en que
// producto mostraron interes. El envio automatico corre como maximo una vez por dia calendario en
// hora de Bogota; ademas hay un disparador manual (/admin/promo-diaria) para enviarla al instante.
// Como el envio ahora usa la plantilla de WhatsApp reactivacion_cliente_galviustech (ver
// enviarPlantillaReactivacion), la variable {{2}} de esa plantilla necesita concordar en genero
// y numero con la palabra fija "nuestro" del texto ya aprobado ("Vi que te interesó nuestro
// {{2}}"). Por eso aqui NO se usa el nombre corto tal cual del producto (por ejemplo "lamparas
// solares" o "impresora termica" no encajarian: "nuestro lamparas..."/"nuestro impresora..." es
// gramaticalmente incorrecto), sino una frase masculina singular que sigue siendo clara para el
// cliente. Los mensajes de config.js (mensajePromoXDiaAnterior) quedan sin usar en este flujo,
// pero se dejan por si se necesitan en otro lado.
const NOMBRE_PRODUCTO_PLANTILLA_POR_CATEGORIA = {
      lampara: "sistema de iluminación solar",
      impresora: "equipo de impresión térmica portátil",
      modem: "modem WiFi portátil",
};

function categoriaPromoDiaria(cliente) {
      const productoId = cliente.pedido?.productoId || cliente.ultimoProducto || null;
      if (!productoId) return null;
      const producto = catalogo.find((p) => p.id === productoId);
      if (!producto) return null;
      // Se revisa el id/nombre (no solo "categoria") para que tambien capture combos que incluyan
      // ese producto, por ejemplo un combo de impresora + obsequio.
      const texto = `${producto.id} ${producto.nombre}`.toLowerCase();
      if (texto.includes("impresora")) return "impresora";
      if (texto.includes("modem")) return "modem";
      if (texto.includes("lampara")) return "lampara";
      return null;
}

function fechaBogotaTexto(fecha) {
      const bogota = new Date(fecha.getTime() - 5 * 60 * 60 * 1000);
      return `${bogota.getUTCFullYear()}-${bogota.getUTCMonth() + 1}-${bogota.getUTCDate()}`;
}

const promoDiariaEnviadaEnProceso = new Set();

// Recorre a TODOS los clientes que no han comprado (sin restringir por cuando escribieron por
// ultima vez) y les envia la promo de su categoria, una sola vez por dia calendario en Bogota.
// La usan tanto el envio automatico como el boton manual del panel admin.
async function ejecutarPromoDiaria() {
      try {
            const { datos } = await leerJSON(CLIENTES_API);
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
            const hoyBogota = fechaBogotaTexto(new Date());

            const enviados = [];
            for (const c of datos) {
                  if (c.pausado) continue;
                  if (telefonosConPedido.has(c.telefono)) continue;
                  if (!c.ultimoContacto) continue;
                  if (c.recordatorios?.promoDiariaFecha === hoyBogota) continue;
                  if (promoDiariaEnviadaEnProceso.has(`${c.telefono}|${hoyBogota}`)) continue;
                  // Si el cliente escribio en los ultimos 15 minutos, esta en plena conversacion
                  // activa ahora mismo: mandarle la plantilla de reactivacion en ese momento se ve
                  // como que el bot esta fallando o repitiendose (se detectaron casos reales donde
                  // le llego en medio de una conversacion, a los pocos segundos de que preguntara
                  // algo). Se le manda la promo diaria otro dia si sigue sin comprar.
                  const minutosDesdeUltimoContacto = (Date.now() - new Date(c.ultimoContacto).getTime()) / 60000;
                  if (minutosDesdeUltimoContacto < 15) continue;

                  const categoria = categoriaPromoDiaria(c);
                  const nombreProductoPlantilla = categoria ? NOMBRE_PRODUCTO_PLANTILLA_POR_CATEGORIA[categoria] : null;
                  if (!nombreProductoPlantilla) continue;

                  try {
                        // Cargar la sesion real ANTES de mandar la plantilla, para no crear sin
                        // querer una sesion en blanco que despues le gane a la real (ver comentario
                        // detallado en enviarRecordatoriosPendientes, mismo bug).
                        await cargarSesionSiNueva(c.telefono);
                        await enviarPlantillaReactivacion(c.telefono, c.nombre || "cliente", nombreProductoPlantilla);
                        promoDiariaEnviadaEnProceso.add(`${c.telefono}|${hoyBogota}`);
                        enviados.push(c.telefono);
                  } catch (errorEnvio) {
                        console.error(`Error enviando promo diaria a ${c.telefono}:`, errorEnvio.response?.data || errorEnvio.message);
                  }
            }

            if (enviados.length > 0) {
                  await marcarPromoDiariaEnviada(enviados, hoyBogota);
            }
            return enviados.length;
      } catch (error) {
            console.error("Error enviando promo diaria:", error.response?.data || error.message);
            return 0;
      }
}

async function marcarPromoDiariaEnviada(telefonos, fechaTexto) {
      await conColaDeArchivo(CLIENTES_API, async () => {
      let intentosRestantes = 4;
      while (true) {
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            let cambios = false;
            for (const telefono of telefonos) {
                  const cliente = datos.find((c) => c.telefono === telefono);
                  if (!cliente) continue;
                  if (!cliente.recordatorios) cliente.recordatorios = {};
                  if (cliente.recordatorios.promoDiariaFecha !== fechaTexto) {
                        cliente.recordatorios.promoDiariaFecha = fechaTexto;
                        cambios = true;
                  }
            }
            if (!cambios) return;
            await guardarJSON(CLIENTES_API, datos, sha, "Promo diaria enviada");
            return;
      } catch (error) {
            const esConflicto = error.response?.status === 409 || error.response?.status === 422;
            if (esConflicto && intentosRestantes > 0) {
                  intentosRestantes--;
                  continue;
            }
            console.error(
                  "Error guardando bandera de promo diaria (los mensajes ya se enviaron; el respaldo en memoria evita que se repitan):",
                  error.response?.data || error.message
                  );
            return;
      }
      }
      });
}

let ultimaFechaPromoDiaria = null;

// Disparo automatico: se intenta en cada webhook entrante, pero solo se ejecuta de verdad una vez
// por dia calendario en Bogota y dentro del horario comercial.
async function enviarPromoDiariaAutomatica() {
      if (!estaEnHorarioComercial()) return;
      const hoyBogota = fechaBogotaTexto(new Date());
      if (ultimaFechaPromoDiaria === hoyBogota) return;
      ultimaFechaPromoDiaria = hoyBogota;
      await ejecutarPromoDiaria();
}

async function enviarListaCategorias(telefono, categorias, opcionesExtra) {
      const registro = registrarMensaje(telefono, "bot", "[Envio menu de categorias]");
      const rows = categorias.map((c) => {
            const info = infoCategoria(c);
            return {
                  id: `cat_${c}`,
                  title: `${info.emoji} ${info.titulo}`.slice(0, 24),
            };
      });
      if (opcionesExtra && opcionesExtra.length > 0) {
            rows.push(...opcionesExtra.map((o) => ({ id: o.id, title: o.titulo.slice(0, 24) })));
      }
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "interactive",
                  interactive: {
                        type: "list",
                        header: { type: "text", text: "Que te interesa?" },
                        body: { text: "Elige una opcion para ver los productos disponibles" },
                        action: {
                              button: "Ver opciones",
                              sections: [
                                    {
                                          title: "Categorias",
                                          rows,
                                    },
                                    ],
                        },
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

// Lista de solo los combos (productos cuyo id empieza con "combo-"), para cuando
// el cliente toca el boton/opcion "Combos" en el saludo inicial.
async function enviarListaCombos(telefono) {
      const combos = catalogo.filter((p) => p.id.startsWith("combo-"));
      if (combos.length === 0) {
            registrarMensaje(telefono, "bot", "[Envio lista de combos]");
            await enviarTexto(telefono, "Por el momento no tenemos combos disponibles, pero cuentame que producto te interesa y te ayudo con gusto.");
            return;
      }
      const registro = registrarMensaje(telefono, "bot", "[Envio lista de combos]");
      const respuesta = await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "interactive",
                  interactive: {
                        type: "list",
                        header: { type: "text", text: "Nuestros Combos" },
                        body: { text: "Estos son los combos disponibles con descuento. Toca uno para ver mas detalles" },
                        action: {
                              button: "Ver combos",
                              sections: [
                                    {
                                          title: "Combos",
                                          rows: combos.map((p) => ({
                                                id: `producto_${p.id}`,
                                                title: (p.nombreCorto || p.nombre).slice(0, 24),
                                                description: formatearPrecio(p.precio),
                                          })),
                                    },
                                    ],
                        },
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
      if (registro) registro.wamid = respuesta.data?.messages?.[0]?.id || null;
}

async function manejarSaludo(telefono, nombreCliente) {
      const sesion = obtenerSesion(telefono);
      sesion.paso = "conversando";
      const categorias = categoriasDisponibles();
      const titulos = categorias.map((c) => infoCategoria(c).titulo);
      const hayCombos = catalogo.some((p) => p.id.startsWith("combo-"));
      const tituloBienvenida = hayCombos ? [...titulos, "PROMOCION COMBOS"] : titulos;
      await enviarTexto(telefono, config.mensajeBienvenida(nombreCliente, tituloBienvenida));

      if (categorias.length === 0 && !hayCombos) {
            return;
      }
      const opcionesExtra = hayCombos ? [{ id: "ver_combos", titulo: "PROMOCION COMBOS" }] : [];
      const totalOpciones = categorias.length + opcionesExtra.length;
      if (totalOpciones <= 3) {
            await enviarBotones(
                  telefono,
                  "Que te interesa?",
                  [
                        ...categorias.map((c) => ({ id: `cat_${c}`, titulo: infoCategoria(c).titulo.slice(0, 20) })),
                        ...opcionesExtra.map((o) => ({ id: o.id, titulo: o.titulo.slice(0, 20) })),
                  ]
                  );
      } else {
            await enviarListaCategorias(telefono, categorias, opcionesExtra);
      }
}

async function manejarSeleccionProducto(telefono, productoId) {
      const sesion = obtenerSesion(telefono);
      const producto = catalogo.find((p) => p.id === productoId);
      if (!producto) {
            await enviarTexto(telefono, "No encontre ese producto, puedes intentar de nuevo?");
            return;
      }
      sesion.paso = "confirmar_producto";
      sesion.pedido.productoId = producto.id;
      sesion.ultimoProducto = producto.id;

      if (producto.imagenes && producto.imagenes.length > 0) {
            for (const url of producto.imagenes) {
                  await enviarImagen(telefono, url, producto.nombreCorto || producto.nombre);
            }
      }

      await enviarTexto(
            telefono,
            `*${producto.nombre}*\n${formatearPrecio(producto.precio)}\n\n${producto.descripcion}`
            );

      // Ademas de mostrar el producto puntual que pidio, se le ensenan de una vez los combos con
      // descuento de su categoria (si tiene) para que los conozca desde este primer momento, no
      // solo como "ultima oportunidad" cuando ya dijo que si al producto suelto. ofrecerComboPromocion
      // sigue existiendo como respaldo para cuando el cliente llega a "quiero pedir" por otro camino
      // (ej. la IA en texto libre), asi que no queda duplicado si de todos modos pasa por ahi.
      const categoria = (producto.categoria || "").trim().toLowerCase();
      const idsCombo = OFERTAS_COMBO_POR_CATEGORIA[categoria] || [];
      const combos = idsCombo.map((id) => catalogo.find((p) => p.id === id)).filter(Boolean);

      if (combos.length > 0) {
            await enviarTexto(
                  telefono,
                  `Tambien tenemos estas promociones que incluyen el ${producto.nombreCorto || producto.nombre}:`
                  );
            for (const combo of combos) {
                  // Cada combo manda primero sus fotos (todas, no solo la primera: con 1 sola foto
                  // muchas veces solo se alcanza a ver el producto principal y el regalo del combo
                  // queda invisible) y JUSTO DESPUES su propio nombre y precio, para que quede
                  // clarisimo a cual combo pertenecen esas fotos, en vez de mandar todas las fotos de
                  // todos los combos primero y un solo resumen junto al final.
                  for (const url of combo.imagenes || []) {
                        await enviarImagen(telefono, url, combo.nombreCorto);
                  }
                  await enviarTexto(telefono, `🎁 *${combo.nombre}* por solo ${formatearPrecio(combo.precio)}`);
            }
            const botones = combos.map((combo) => ({
                  id: `combo_${combo.id}_${producto.id}`,
                  titulo: etiquetaBotonCombo(combo),
                  }));
            // pedirfinal_ va directo a iniciarPedido (sin volver a pasar por ofrecerComboPromocion):
            // el cliente ya vio los combos aqui mismo, repetirselos justo despues seria redundante.
            botones.push({ id: `pedirfinal_${producto.id}`, titulo: "Solo este producto" });
            await enviarBotones(telefono, "Que prefieres?", botones);
      } else {
            await enviarBotones(telefono, "Quieres pedir este producto?", [
                  { id: `pedir_${producto.id}`, titulo: "Si, quiero este" },
                  { id: "ver_catalogo", titulo: "Ver otros" },
                  ]);
      }
}

async function iniciarPedido(telefono, productoId) {
      const sesion = obtenerSesion(telefono);
      const producto = catalogo.find((p) => p.id === productoId);
      if (!producto) {
            await enviarTexto(telefono, "No encontre ese producto en el catalogo, puedes elegir otro?");
            return;
      }

      // Si este cliente ya tiene un pedido registrado antes (con datos completos de envio), no le
      // volvemos a pedir todo de nuevo: reutilizamos esos datos para este nuevo pedido y registramos
      // de una vez, dejandole claro que puede corregir algo si cambio.
      let pedidoAnterior = null;
      try {
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            pedidoAnterior = pedidos.find((p) => p.telefono === telefono) || null;
      } catch (error) {
            console.error("Error revisando pedidos anteriores:", error.response?.data || error.message);
      }

      const tieneDatosCompletos =
            pedidoAnterior && pedidoAnterior.nombreCliente && pedidoAnterior.celular && pedidoAnterior.direccion;

      if (tieneDatosCompletos) {
            sesion.paso = "conversando";
            sesion.ultimoProducto = producto.id;
            sesion.pedido = {};
            const nuevoPedido = {
                  productoId,
                  nombreProducto: producto.nombre,
                  precio: producto.precio,
                  telefono,
                  nombreCliente: pedidoAnterior.nombreCliente,
                  celular: pedidoAnterior.celular,
                  departamento: pedidoAnterior.departamento,
                  ciudad: pedidoAnterior.ciudad,
                  direccion: pedidoAnterior.direccion,
                  barrio: pedidoAnterior.barrio,
                  medioPago: pedidoAnterior.medioPago,
            };
            await enviarTexto(
                  telefono,
                  `Genial, elegiste *${producto.nombre}* (${formatearPrecio(producto.precio)}). Como ya tengo tus datos de un pedido anterior, los voy a usar para este nuevo pedido. Si necesitas cambiar algo (direccion, celular, etc.) dime cual y te lo corrijo.`
                  );
            // Mismo fix que en manejarFlujoPedido: guardar PRIMERO, confirmar solo si de verdad
            // quedo guardado (ver comentario detallado junto a guardarPedido).
            const guardadoExitoso = await guardarPedido(nuevoPedido);
            if (guardadoExitoso) {
                  if ((nuevoPedido.medioPago || "").toLowerCase().includes("transf")) {
                        await enviarTexto(telefono, config.mensajeDatosTransferencia);
                  }
                  await enviarTexto(telefono, config.mensajeResumenPedido(nuevoPedido));
                  await enviarTexto(telefono, config.mensajeResponsabilidadPedido);
            } else {
                  await enviarTexto(
                        telefono,
                        "Ya tengo todos tus datos, pero tuve un problema tecnico dejando tu pedido registrado en el sistema. Dame un momento para confirmarte que quedo todo listo, no te preocupes que tus datos no se pierden."
                        );
                  sesion.necesitaAtencion = true;
                  sesion.motivoAtencion = "No se pudo guardar el pedido automaticamente por un fallo tecnico (repeticion de pedido con datos anteriores). Revisar y registrar el pedido manualmente.";
            }
            return;
      }

      sesion.paso = "pedido_nombre";
      sesion.ultimoProducto = producto.id;
      sesion.pedido = { productoId, nombreProducto: producto.nombre, precio: producto.precio, telefono };
      await enviarTexto(
            telefono,
            `Genial, elegiste *${producto.nombre}* (${formatearPrecio(producto.precio)}). Para generar tu pedido necesito algunos datos.\n\nPara empezar, cual es tu nombre completo?`
            );
}

// Lista de departamentos de Colombia (incluye Bogota, aunque tecnicamente es un distrito
// capital y no un departamento) usada para detectar el departamento en cualquier parte de un
// mensaje del cliente, sin importar tildes o mayusculas/minusculas.
const DEPARTAMENTOS_COLOMBIA = [
      "Amazonas", "Antioquia", "Arauca", "Atlantico", "Bogota", "Bolivar", "Boyaca", "Caldas",
      "Caqueta", "Casanare", "Cauca", "Cesar", "Choco", "Cordoba", "Cundinamarca", "Guainia",
      "Guaviare", "Huila", "La Guajira", "Guajira", "Magdalena", "Meta", "Narino",
      "Norte de Santander", "Putumayo", "Quindio", "Risaralda", "San Andres", "Santander",
      "Sucre", "Tolima", "Valle del Cauca", "Valle", "Vaupes", "Vichada",
];

function quitarTildes(texto) {
      return (texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Cuando un cliente manda varios datos del pedido juntos en un solo mensaje (ej. "Yoleidis rios
// 3145681361 Tolima combenio kra2#8-35 pasos arriba de la estacion de policia"), esta funcion
// intenta rescatar el celular, el departamento y el medio de pago sin importar en que parte del
// mensaje esten, para no tener que volver a pedirlos si ya vinieron ahi. Tambien devuelve el
// texto ANTES del primer dato encontrado, que sirve para aislar el nombre del resto del mensaje
// (en el ejemplo de arriba, "Yoleidis rios"). Deliberadamente NO intenta separar ciudad,
// direccion o barrio de un mensaje mixto: eso es mucho mas ambiguo y el riesgo de guardar mal
// esos datos es mayor que el de simplemente volver a preguntarlos.
function extraerCamposPedido(texto) {
      const original = texto || "";
      const resultado = { celular: null, departamento: null, medioPago: null, posicionPrimerDato: null };

      const marcarPosicion = (indice) => {
            if (indice === -1 || indice === undefined) return;
            if (resultado.posicionPrimerDato === null || indice < resultado.posicionPrimerDato) {
                  resultado.posicionPrimerDato = indice;
            }
      };

      const matchCelular = original.match(/(?:\+?57[\s-]*)?(\d[\d\s-]{5,12}\d)/);
      if (matchCelular) {
            const digitos = matchCelular[1].replace(/\D/g, "");
            if (digitos.length >= 7 && digitos.length <= 10) {
                  resultado.celular = digitos;
                  marcarPosicion(matchCelular.index);
            }
      }

      const textoSinTildes = quitarTildes(original).toLowerCase();
      for (const depto of DEPARTAMENTOS_COLOMBIA) {
            const deptoSinTildes = quitarTildes(depto).toLowerCase();
            const indice = textoSinTildes.indexOf(deptoSinTildes);
            if (indice !== -1) {
                  resultado.departamento = depto === "Guajira" ? "La Guajira" : depto === "Valle" ? "Valle del Cauca" : depto;
                  marcarPosicion(indice);
                  break;
            }
      }

      const matchPago = original.match(/contra\s*entrega|efectivo|transferencia|nequi|daviplata|bancolombia|\bpse\b|tarjeta|\bgiro\b/i);
      if (matchPago) {
            resultado.medioPago = matchPago[0];
            marcarPosicion(matchPago.index);
      }

      resultado.textoAntesDelPrimerDato =
            resultado.posicionPrimerDato !== null ? original.slice(0, resultado.posicionPrimerDato).trim() : null;

      return resultado;
}

// Define, en orden, cada campo que necesita el flujo de pedido: en que paso se pide, con que
// "tipo" se valida (ver pareceRespuestaValidaPedido), que pregunta se manda y que mensaje de
// error se manda si la respuesta no parece valida. manejarFlujoPedido usa esta lista para saber
// dinamicamente cual es el siguiente dato que falta, en lugar de avanzar paso por paso a ciegas.
const DEFINICIONES_CAMPOS_PEDIDO = [
      {
            campo: "nombreCliente",
            paso: "pedido_nombre",
            tipo: "nombre",
            pregunta: "Para empezar, cual es tu nombre completo?",
            mensajeError: "Disculpa, no logre leer bien tu nombre. Me lo puedes escribir de nuevo?",
      },
      {
            campo: "celular",
            paso: "pedido_celular",
            tipo: "celular",
            pregunta: "Cual es tu numero de celular?",
            mensajeError: "Ese numero no me quedo claro. Me puedes escribir tu numero de celular completo (10 digitos)?",
      },
      {
            campo: "departamento",
            paso: "pedido_departamento",
            tipo: "departamento",
            pregunta: "En que departamento vives?",
            mensajeError: "Disculpa, no entendi bien ese departamento. Me lo confirmas de nuevo?",
      },
      {
            campo: "ciudad",
            paso: "pedido_ciudad",
            tipo: "ciudad",
            pregunta: "Y en que ciudad o municipio?",
            mensajeError: "No logre entender la ciudad o municipio. Me la puedes escribir de nuevo?",
      },
      {
            campo: "direccion",
            paso: "pedido_direccion",
            tipo: "direccion",
            pregunta: "Cual es tu direccion completa?",
            mensajeError: "Esa direccion me quedo muy incompleta. Me la puedes escribir completa (calle, numero, etc)?",
      },
      {
            campo: "barrio",
            paso: "pedido_barrio",
            tipo: "barrio",
            pregunta: "En que barrio queda esa direccion?",
            mensajeError: "No logre entender el barrio. Me lo puedes confirmar de nuevo?",
      },
      {
            campo: "medioPago",
            paso: "pedido_pago",
            tipo: "pago",
            pregunta: "Por ultimo, que medio de pago prefieres? (contraentrega, transferencia u otro)",
            mensajeError: "No identifique ese medio de pago. Me confirmas si es contraentrega, transferencia u otro?",
      },
];

// Valida que la respuesta del cliente durante el flujo de pedido tenga un minimo de sentido para
// el campo que se esta pidiendo, para no avanzar el pedido con datos que claramente son basura
// (ej. "Gfh", "asdf", una respuesta de pago que no es ninguna de las opciones). No puede detectar
// TODO dato invalido (una direccion real puede tener cualquier forma), pero si filtra los casos
// obvios de texto sin sentido.
function pareceRespuestaValidaPedido(texto, tipo) {
      const limpio = (texto || "").trim();
      if (!limpio) return false;

      const tieneVocal = /[aeiouáéíóúAEIOUÁÉÍÓÚ]/.test(limpio);
      const soloLetrasYEspacios = /^[a-zA-ZÀ-ÿ\s.'-]+$/.test(limpio);
      const tieneLetra = /[a-zA-ZÀ-ÿ]/.test(limpio);

      switch (tipo) {
            case "nombre":
                  // tieneLetra evita que un numero de celular u otro texto sin ninguna letra
                  // (que no es "solo letras y espacios") se cuele como si fuera un nombre valido.
                  return limpio.length >= 3 && tieneLetra && (!soloLetrasYEspacios || tieneVocal);
            case "celular": {
                  const digitos = limpio.replace(/\D/g, "");
                  return digitos.length >= 7;
            }
            case "departamento":
            case "ciudad":
            case "barrio":
                  return limpio.length >= 3 && (!soloLetrasYEspacios || tieneVocal);
            case "direccion":
                  return limpio.length >= 5;
            case "pago":
                  return /contra|entrega|efectiv|transf|nequi|davipl|bancol|pse|tarjeta|otro|giro/i.test(limpio);
            default:
                  return true;
      }
}

// Detecta si, en medio del flujo de pedido, el cliente en realidad esta preguntando algo (por
// ejemplo sobre el producto, el envio o un repuesto) en vez de responder el dato que se le pidio.
// No puede detectar toda pregunta posible (algunas no llevan signos ni palabras interrogativas
// claras), pero cubre los casos mas comunes sin generar falsos positivos sobre respuestas cortas
// normales como "Contraentrega" o "Envigado".
// tipoEsperado (opcional) es el tipo de dato que se le pidio (ver DEFINICIONES_CAMPOS_PEDIDO): para
// el celular, que tiene un formato muy especifico (digitos), lo usamos como señal extra: un mensaje
// con letras y sin ni siquiera un numero parecido a un celular es mucho mas probable que sea un
// comentario o pregunta metida en medio del flujo, que un intento real de responder el celular.
function pareceMasPreguntaQueRespuesta(texto, tipoEsperado) {
      const limpio = (texto || "").trim();
      if (!limpio) return false;
      if (/[?¿]/.test(limpio)) return true;

      const palabras = limpio.toLowerCase().split(/\s+/).filter(Boolean);

      const inicios = [
            "que", "qué", "cual", "cuál", "cuales", "cuáles", "como", "cómo", "cuando", "cuándo",
            "donde", "dónde", "cuanto", "cuánto", "cuantos", "cuántos", "cuantas", "cuántas",
            "tiene", "tienen", "hay", "cuentame", "cuéntame", "explicame", "explícame",
            "hablame", "háblame", "dime", "dígame", "digame",
            // Abreviaturas muy comunes al escribir rapido en Colombia ("q" por "que", "xq"/"pq" por
            // "por que"), que sin esto se cuelan como si fueran una respuesta normal del pedido.
            "q", "xq", "pq",
            ];
      // Revisamos las primeras 2 palabras (no solo la primera) para cubrir preguntas como "Con
      // cuantos gigas viene" o "De que color es", sin llegar a revisar todo el mensaje (eso ya
      // subiria el riesgo de falsos positivos sobre datos reales del pedido).
      if (palabras.length >= 3 && palabras.slice(0, 2).some((palabra) => inicios.includes(palabra))) {
            return true;
      }

      // Preguntas frecuentes sobre el producto que NO empiezan con una palabra interrogativa
      // clasica (ej. "Y las hojas las envian", "Eso incluye envio", "Trae cargador") tampoco las
      // detecta el chequeo de arriba, y se colaban como si fueran la respuesta al dato que se
      // estaba pidiendo. Asi paso con un pedido real: "Y las hojas las envian" quedo guardado
      // como si fuera el nombre completo del cliente (24-sep-2026, Constanza). Buscamos estos
      // verbos tipicos de pregunta sobre el producto en cualquier parte de un mensaje corto (hasta
      // 6 palabras), sin exigir que esten al inicio.
      const verbosDePregunta = [
            "envian", "envía", "envia", "incluye", "incluyen", "trae", "traen", "viene", "vienen",
            "cabe", "caben", "sirve", "sirven", "dura", "duran", "demora", "demoran",
            ];
      if (palabras.length <= 6 && palabras.some((palabra) => verbosDePregunta.includes(palabra))) {
            return true;
      }

      if (tipoEsperado === "celular" && palabras.length >= 2) {
            const digitos = limpio.replace(/\D/g, "");
            const tieneLetra = /[a-zA-ZÀ-ÿ]/.test(limpio);
            // Menos de 7 digitos y con letras: no es un intento razonable de dar el numero, es otra
            // cosa (duda, comentario, pregunta sin signos ni palabra interrogativa reconocida).
            if (digitos.length < 7 && tieneLetra) return true;
      }

      return false;
}

async function manejarFlujoPedido(telefono, texto) {
      const sesion = obtenerSesion(telefono);
      const definicionActual = DEFINICIONES_CAMPOS_PEDIDO.find((d) => d.paso === sesion.paso);
      if (!definicionActual) return false;

      // Si en medio del flujo de pedido el cliente en realidad esta haciendo una pregunta (no
      // dando el dato que se le pidio), no la tratemos como si fuera la respuesta del campo
      // actual (eso guardaria basura como "nombre" y dejaria la pregunta sin contestar). En su
      // lugar, respondemos la pregunta con la IA (con el catalogo completo disponible) y despues
      // volvemos a hacer la misma pregunta del campo pendiente, sin perder el avance del pedido.
      if (pareceMasPreguntaQueRespuesta(texto, definicionActual.tipo)) {
            const productoIdEnfoque = sesion.pedido?.productoId || sesion.ultimoProducto || null;
            const enfoqueProducto = productoIdEnfoque ? { tipo: "producto", valor: productoIdEnfoque } : null;
            try {
                  const { mensajeVisible } = await preguntarleALaIA(sesion, texto, enfoqueProducto);
                  if (mensajeVisible) {
                        await enviarTexto(telefono, mensajeVisible);
                  }
            } catch (error) {
                  console.error("Error respondiendo pregunta durante el flujo de pedido:", error.response?.data || error.message);
            }
            await enviarTexto(telefono, definicionActual.pregunta);
            return true;
      }

      // Intenta rescatar datos que el cliente haya mandado todos juntos en un solo mensaje
      // (celular, departamento, medio de pago), sin importar en que paso del flujo estemos. Solo
      // los llena si todavia no los teniamos, para no pisar un dato ya confirmado antes con un
      // falso positivo de un mensaje posterior (ej. una direccion que por casualidad contenga una
      // secuencia de numeros parecida a un celular).
      const extraidos = extraerCamposPedido(texto);
      if (!sesion.pedido.celular && extraidos.celular) sesion.pedido.celular = extraidos.celular;
      if (!sesion.pedido.departamento && extraidos.departamento) sesion.pedido.departamento = extraidos.departamento;
      if (!sesion.pedido.medioPago && extraidos.medioPago) sesion.pedido.medioPago = extraidos.medioPago;

      // Si el campo del paso actual sigue vacio (no vino en la extraccion de arriba), lo
      // validamos y lo llenamos con la respuesta de este mensaje, igual que antes.
      if (!sesion.pedido[definicionActual.campo]) {
            // Para el nombre: si en el mismo mensaje detectamos otros datos (celular, departamento,
            // etc.), usamos solo el texto ANTES del primer dato encontrado, para no guardar el
            // mensaje completo como si fuera el nombre.
            let textoParaValidar = texto;
            if (definicionActual.campo === "nombreCliente" && extraidos.textoAntesDelPrimerDato) {
                  textoParaValidar = extraidos.textoAntesDelPrimerDato;
            }

            if (!pareceRespuestaValidaPedido(textoParaValidar, definicionActual.tipo)) {
                  await enviarTexto(telefono, definicionActual.mensajeError);
                  return true;
            }

            sesion.pedido[definicionActual.campo] = textoParaValidar;
      }

      // Busca cual es el siguiente campo que todavia falta, saltando los que ya se llenaron (por
      // ejemplo porque el cliente los mando todos juntos en un solo mensaje), en lugar de avanzar
      // paso por paso a ciegas.
      const siguienteFaltante = DEFINICIONES_CAMPOS_PEDIDO.find((d) => !sesion.pedido[d.campo]);

      if (!siguienteFaltante) {
            // Guardamos el pedido ANTES de decirle al cliente que "ya quedo listo": si le
            // confirmamos primero y el guardado falla despues, el cliente se queda tranquilo
            // pensando que ya compro, pero el pedido nunca llega a Dropi/despacho. Asi fue como se
            // perdio la venta de Jose Gabriel Diaz Gutierrez (584261736349) el 22/09.
            const pedidoAGuardar = sesion.pedido;
            const guardadoExitoso = await guardarPedido(pedidoAGuardar);

            if (guardadoExitoso) {
                  if ((pedidoAGuardar.medioPago || "").toLowerCase().includes("transf")) {
                        await enviarTexto(telefono, config.mensajeDatosTransferencia);
                  }
                  await enviarTexto(telefono, config.mensajeResumenPedido(pedidoAGuardar));
                  await enviarTexto(telefono, config.mensajeResponsabilidadPedido);
            } else {
                  // No le decimos que ya quedo listo si en realidad no se guardo: le avisamos con
                  // honestidad que hubo un problema tecnico, y escalamos a Wendy (necesitaAtencion)
                  // para que lo registre manualmente con los datos que ya quedaron en el chat.
                  await enviarTexto(
                        telefono,
                        "Ya tengo todos tus datos, pero tuve un problema tecnico dejando tu pedido registrado en el sistema. Dame un momento para confirmarte que quedo todo listo, no te preocupes que tus datos no se pierden."
                        );
                  sesion.necesitaAtencion = true;
                  sesion.motivoAtencion = "No se pudo guardar el pedido automaticamente por un fallo tecnico. Los datos completos del cliente ya estan en esta conversacion: revisar y registrar el pedido manualmente.";
            }

            sesion.paso = "conversando";
            sesion.pedido = {};
            return true;
      }

      sesion.paso = siguienteFaltante.paso;
      await enviarTexto(telefono, siguienteFaltante.pregunta);
      return true;
}

function detectarProductoEspecifico(texto) {
      const t = texto.toLowerCase();
      if (t.includes("impresora") || t.includes("imprimir")) {
            return "impresora-termica";
      }
      const tiene4g = t.includes("4g");
      const tiene5g = t.includes("5g");
      if (tiene4g && tiene5g) {
            return "modem-4g5g";
      }
      if (tiene4g) {
            return "modem-4g";
      }
      if (tiene5g) {
            return "modem-portatil-5g";
      }
      return null;
}

function detectarProductoPorPalabraClave(texto) {
      const t = texto.toLowerCase();
      for (const categoria of categoriasDisponibles()) {
            const info = infoCategoria(categoria);
            if (info.palabras.some((palabra) => t.includes(palabra))) {
                  return categoria;
            }
      }
      return null;
}

// Respaldo determinista de "que categoria estamos enfocando" cuando la IA no genero ninguna
// respuesta (ver RESPALDO CONTRA SILENCIO TOTAL en manejarTextoLibre). enfoqueProducto puede venir
// como {tipo:"categoria", valor} directo, o como {tipo:"producto", valor: idProducto} - en ese
// caso hay que ir al catalogo a buscar de que categoria es ese producto puntual.
function categoriaDeEnfoque(enfoqueProducto) {
      if (!enfoqueProducto) return null;
      if (enfoqueProducto.tipo === "categoria") return enfoqueProducto.valor;
      if (enfoqueProducto.tipo === "producto") {
            const p = catalogo.find((prod) => prod.id === enfoqueProducto.valor);
            return p ? (p.categoria || "").trim().toLowerCase() : null;
      }
      return null;
}

// RESPALDO DETERMINISTA PARA EL MODEM (sep-2026): el caso mas comun de "silencio total" de la IA
// pasa justo despues de la pregunta de zona rural/ciudad del modem, cuando el cliente responde algo
// corto (una vereda, un municipio) - ver RESPALDO CONTRA SILENCIO TOTAL. En vez de solo evitar el
// silencio con un mensaje generico que le vuelve a preguntar lo mismo (dejando al cliente sin la
// info que realmente necesita), en este caso puntual le mandamos directamente las 3 versiones del
// modem con sus precios reales del catalogo: es exactamente lo que la IA deberia haberle mandado.
async function enviarVersionesModem(telefono) {
      const versiones = catalogo
            .filter((p) => !p.id.startsWith("combo-") && (p.categoria || "").trim().toLowerCase() === "modem")
            .slice()
            .sort((a, b) => (a.precio || 0) - (b.precio || 0));
      if (versiones.length === 0) {
            await enviarTexto(telefono, "Cuentame un poco mas para poder ayudarte mejor.");
            return;
      }
      const lineas = versiones.map((p) => `*${p.nombreCorto || p.nombre}* - ${formatearPrecio(p.precio)}`).join("\n");
      const infoModem = infoCategoria("modem");
      const destacado = versiones.find((p) => p.id === infoModem.variantePorDefecto);
      const recomendacion = destacado
            ? `Si no estas seguro de la cobertura en tu zona, te recomiendo el *${destacado.nombreCorto || destacado.nombre}*: funciona tanto donde solo hay 4G como donde ya llega 5G.`
            : "";
      await enviarTexto(
            telefono,
            `Estas son nuestras 3 versiones del modem:\n\n${lineas}\n\n${recomendacion}\n\nTe ayudo a dejar tu pedido listo con cual de las 3?`.trim()
            );
}

async function manejarTextoLibre(telefono, texto) {
      const sesion = obtenerSesion(telefono);

      const manejado = await manejarFlujoPedido(telefono, texto);
      if (manejado) return;

      if (detectarPreguntaUso(texto)) {
            await enviarModoDeUso(telefono);
            return;
      }

      if (detectarPreguntaFotos(texto)) {
            await enviarFotosProducto(telefono, texto);
            return;
      }

      const productoDetectado = detectarProductoEspecifico(texto);
      const categoriaDetectada = !productoDetectado ? detectarProductoPorPalabraClave(texto) : null;
      let enfoqueProducto = null;
      if (productoDetectado) {
            enfoqueProducto = { tipo: "producto", valor: productoDetectado };
            sesion.ultimoProducto = productoDetectado;
      } else if (categoriaDetectada) {
            enfoqueProducto = { tipo: "categoria", valor: categoriaDetectada };
      } else if (sesion.pedido?.productoId || sesion.ultimoProducto) {
            enfoqueProducto = { tipo: "producto", valor: sesion.pedido?.productoId || sesion.ultimoProducto };
      } else if (sesion.ultimaCategoria) {
            // Ultimo recurso: no hay un producto puntual identificado, pero si sabemos de que
            // categoria se estaba hablando (ej. le mostramos los 3 modems y aun no dijo cual).
            // Sin esto, una respuesta corta como "precio" o "este" quedaba sin ningun contexto.
            enfoqueProducto = { tipo: "categoria", valor: sesion.ultimaCategoria };
      }

      // Cuenta cuantas veces el cliente ha preguntado algo sobre este MISMO producto puntual sin
      // haber avanzado a pedirlo. La IA ya trae instrucciones de cierre en su guion, pero en
      // conversaciones largas tiende a quedarse respondiendo de forma informativa indefinidamente
      // (ver estudio de conversion de sep-2026). Este contador es un respaldo mecanico: no depende
      // de que la IA decida cerrar por su cuenta.
      if (!sesion.preguntasPorProducto) sesion.preguntasPorProducto = {};
      if (!sesion.botonesOfrecidos) sesion.botonesOfrecidos = {};
      const idProductoEnfocado = enfoqueProducto?.tipo === "producto" ? enfoqueProducto.valor : null;
      if (idProductoEnfocado) {
            sesion.preguntasPorProducto[idProductoEnfocado] = (sesion.preguntasPorProducto[idProductoEnfocado] || 0) + 1;
      }

      try {
            const { mensajeVisible, productoId, productoActual, necesitaAsesor, pausarSeguimiento } = await preguntarleALaIA(sesion, texto, enfoqueProducto);

            // Se pone en true apenas el cliente reciba ALGO (texto, botones, o se le inicie un
            // pedido/combo). Sirve para detectar el caso en que la IA respondio sin lanzar ningun
            // error pero tampoco genero nada que enviarle al cliente (ver bug de silencio total
            // mas abajo).
            let seLeRespondioAlgo = false;

            if (mensajeVisible) {
                  await enviarTexto(telefono, mensajeVisible);
                  seLeRespondioAlgo = true;
            }

            if (productoActual && catalogo.some((p) => p.id === productoActual)) {
                  sesion.ultimoProducto = productoActual;
            }

            if (productoId) {
                  const existe = catalogo.find((p) => p.id === productoId);
                  if (existe) {
                        sesion.ultimoProducto = productoId;
                        if (productoId.startsWith("combo-")) {
                              await iniciarPedido(telefono, productoId);
                        } else {
                              await ofrecerComboPromocion(telefono, productoId);
                        }
                        seLeRespondioAlgo = true;
                  } else {
                        // La IA devolvio un id de producto que no existe en el catalogo (ej. "modem"
                        // en vez de "modem-4g5g"): no se rompe nada, pero tampoco se le manda nada al
                        // cliente por esta via. Se deja registrado para poder detectar el patron si se
                        // repite.
                        console.error(`ACCION_PEDIDO con producto invalido "${productoId}" para ${telefono}`);
                  }
            }

            // RESPALDO MECANICO DE CIERRE: si la IA ya respondio 2 o mas veces sobre el mismo
            // producto puntual sin que ella misma haya decidido pasar a pedirlo (osea, sin
            // ACCION_PEDIDO), le mandamos de una vez los botones directos de "Si, quiero este /
            // Ver otros" para esa segunda respuesta en adelante.
            // IMPORTANTE (sep-2026): antes esto se ofrecia UNA sola vez por producto en toda la
            // conversacion (flag booleano). Se detecto en vivo (clientes "MI$T€R" y "More") que un
            // cliente con intencion de compra clara (ya eligio version, ya dijo si quiere recoger en
            // oficina o que se lo envien) se puede quedar dando vueltas mas de 2 mensajes despues de
            // ese primer ofrecimiento, sin que la IA agregue ACCION_PEDIDO, y como el flag ya estaba
            // en true nunca se le volvia a ofrecer un cierre directo: quedaba "a mitad del pedido"
            // hasta que Wendy lo rescataba a mano. Ahora en vez de un flag booleano se guarda EN QUE
            // conteo se ofrecio la ultima vez, y se vuelve a ofrecer cada 2 mensajes adicionales sin
            // cierre (conteo 2, 4, 6, 8...) mientras la IA siga sin cerrar.
            if (
                  idProductoEnfocado &&
                  !productoId &&
                  !pausarSeguimiento &&
                  sesion.preguntasPorProducto[idProductoEnfocado] >= 2 &&
                  sesion.preguntasPorProducto[idProductoEnfocado] % 2 === 0 &&
                  sesion.botonesOfrecidos[idProductoEnfocado] !== sesion.preguntasPorProducto[idProductoEnfocado]
                  ) {
                  const productoEnfocado = catalogo.find((p) => p.id === idProductoEnfocado);
                  if (productoEnfocado) {
                        sesion.botonesOfrecidos[idProductoEnfocado] = sesion.preguntasPorProducto[idProductoEnfocado];
                        await enviarBotones(telefono, "Te ayudo a dejar tu pedido listo?", [
                              { id: `pedir_${idProductoEnfocado}`, titulo: "Si, quiero este" },
                              { id: "ver_catalogo", titulo: "Ver otros" },
                              ]);
                        seLeRespondioAlgo = true;
                  }
            }

            // RESPALDO CONTRA SILENCIO TOTAL (bug detectado sep-2026): al menos 3 clientes
            // distintos (Widmark, Carlos Eduardo Cordon, y otro) contestaron la pregunta del modem
            // sobre zona rural/ciudad con un mensaje que empezaba con "Vereda" o "Zona rural", la IA
            // respondio sin ningun texto visible para el cliente (probablemente solo con lineas de
            // control como PRODUCTO_ACTUAL/ACCION_PEDIDO con un id invalido o similar) y ninguna de
            // las ramas de arriba le mando nada al cliente. Como ademas no hubo ningun error, el
            // catch de mas abajo tampoco se disparaba: el cliente se quedaba esperando una respuesta
            // para siempre y el chat ni siquiera aparecia en "Necesitan tu respuesta". En vez de
            // asumir que la IA siempre genera algo util, si al final de todo esto no se le mando
            // nada en absoluto al cliente, lo tratamos igual que un fallo tecnico: se escala a Wendy
            // y se le avisa al cliente que puede intentar de nuevo, en lugar de dejarlo en silencio.
            if (!seLeRespondioAlgo) {
                  console.error(
                        `La IA no genero ninguna respuesta visible para ${telefono}. Mensaje del cliente: "${texto}"`
                        );
                  sesion.necesitaAtencion = true;
                  sesion.motivoAtencion = `El bot no genero ninguna respuesta para este mensaje: "${texto.slice(0, 100)}"`;
                  // Se sigue escalando SIEMPRE (para que Wendy vea el patron si se repite), pero en
                  // vez de un mensaje generico que solo repite la pregunta, si el contexto es el
                  // modem le mandamos de una vez las 3 versiones con precios reales: es justo lo que
                  // la IA no logro escribir, y asi el cliente si avanza en vez de quedar en el mismo
                  // punto muerto otra vez (ver enviarVersionesModem).
                  if (categoriaDeEnfoque(enfoqueProducto) === "modem") {
                        await enviarVersionesModem(telefono);
                  } else {
                        await enviarTexto(
                              telefono,
                              "Cuentame un poco mas para poder ayudarte mejor, o si prefieres dime directamente en que ciudad o vereda estas y para que lo necesitas."
                              );
                  }
            }

            // La propia IA nos avisa cuando no puede resolverle algo al cliente con seguridad
            // (por ejemplo pide hablar con una persona, o pregunta algo fuera de lo que sabe).
            // Lo marcamos para que aparezca en la casilla de "Necesitan tu respuesta" del panel.
            if (necesitaAsesor) {
                  sesion.necesitaAtencion = true;
                  sesion.motivoAtencion = `El cliente pregunto algo que la IA no pudo resolver con seguridad: "${texto.slice(0, 100)}"`;
            }

            // El cliente dijo explicitamente que el mismo va a avisar despues, o que no le
            // escriban mas por ahora. Lo guardamos para que enviarRecordatoriosPendientes (los
            // mensajes automaticos de 2/5/8/11 horas y la plantilla de reactivacion) deje de
            // escribirle solo, sin necesidad de que Wendy lo pause manualmente uno por uno.
            if (pausarSeguimiento) {
                  sesion.pausarSeguimiento = true;
            }
      } catch (error) {
            console.error("Error consultando la IA:", error.response?.data || error.message);
            // Fallo tecnico consultando la IA (ej. saldo de Anthropic agotado, caida de red).
            // Marcamos el chat para que aparezca en la casilla de "Necesitan tu respuesta" del
            // panel, asi Wendy sabe cuales clientes quedaron sin una respuesta real del bot.
            sesion.necesitaAtencion = true;
            sesion.motivoAtencion = `El bot no pudo procesar este mensaje: "${texto.slice(0, 100)}"`;
            try {
                  await enviarTexto(
                        telefono,
                        "Disculpa, tuve un problema para procesar tu mensaje. Puedes intentar de nuevo?"
                        );
            } catch (errorAviso) {
                  // Si tampoco se pudo avisar al cliente (ej. WhatsApp rechazo el envio), no
                  // dejamos que este segundo error se propague y tumbe el procesamiento del
                  // webhook completo; ya quedo marcado como "necesita atencion" arriba.
                  console.error("Error avisando fallo al cliente:", errorAviso.response?.data || errorAviso.message);
            }
      }
}

function requiereLogin(req, res, next) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Basic ")) {
            res.set("WWW-Authenticate", 'Basic realm="Panel Galviustech"');
            return res.status(401).send("Autenticacion requerida");
      }
      const [usuario, clave] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
      if (usuario === ADMIN_USER && clave === ADMIN_PASS) {
            return next();
      }
      res.set("WWW-Authenticate", 'Basic realm="Panel Galviustech"');
      return res.status(401).send("Credenciales incorrectas");
}

app.get("/admin", requiereLogin, async (req, res) => {
      try {
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const { datos: clientes } = await leerJSON(CLIENTES_API);
		  const filtroActivo = req.query.filtro || "todos";
		  const categoriaActiva = req.query.categoria || "todas";
		  const clientesFiltradosPorFecha = filtrarClientesPorFecha(clientes, filtroActivo);
		  const clientesFiltrados = filtrarClientesPorCategoria(clientesFiltradosPorFecha, categoriaActiva);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));

            // Chats donde el bot no pudo responder (fallo tecnico o la IA no supo resolverlo con
            // seguridad) y que por eso necesitan que Wendy responda personalmente. Se muestran
            // siempre, sin importar los filtros de fecha/categoria de arriba, porque son urgentes.
            const clientesNecesitanAtencion = clientes
                  .filter((c) => c.necesitaAtencion)
                  .sort((a, b) => new Date(b.ultimoContacto || 0) - new Date(a.ultimoContacto || 0));

            const grupos = {};
            ETAPAS.forEach((e) => {
                  grupos[e.id] = [];
            });
            clientesFiltrados.forEach((c) => {
                  const etapa = calcularEtapa(c, telefonosConPedido);
                  if (!grupos[etapa]) grupos[etapa] = [];
                  grupos[etapa].push(c);
            });

            const columnas = ETAPAS.map((e) => {
                  const items = grupos[e.id] || [];
                  const tarjetas = items
                  .map(
                        (c) => `
                        <div class="tarjeta">
						<input type="checkbox" class="check-eliminar" value="${c.telefono}" style="float:right;">
						
                        <div class="tarjeta-nombre">${c.nombre || "(sin nombre)"}</div>
                        <div class="tarjeta-tel">${c.telefono}</div>
                        <a href="/admin/chat/${encodeURIComponent(c.telefono)}">Ver / Escribir</a>
						<a href="/admin/eliminar/${encodeURIComponent(c.telefono)}" onclick="return confirm('Eliminar a ${(c.nombre || c.telefono).replace(/'/g, "")}? Esta accion no se puede deshacer.');" style="color:#c0392b;">Eliminar</a>
                        <form method="POST" action="/admin/etapa/${encodeURIComponent(c.telefono)}">
                        <select name="etapa" onchange="this.form.submit()">
                        <option value="auto" ${!c.etapaManual ? "selected" : ""}>Automatico</option>
                        ${ETAPAS.map((op) => `<option value="${op.id}" ${c.etapaManual === op.id ? "selected" : ""}>${op.emoji} ${op.id}</option>`).join("")}
                        </select>
                        </form>
                        </div>`
                        )
                  .join("");
                  return `
                  <div class="columna">
                  <div class="columna-titulo">${e.emoji} ${e.id} <span class="contador">${items.length}</span></div>
                  ${tarjetas}
                  </div>`;
            }).join("");

            const bloqueAtencion = clientesNecesitanAtencion.length === 0 ? "" : `
            <div class="atencion-caja">
            <div class="atencion-titulo">🆘 Necesitan tu respuesta (${clientesNecesitanAtencion.length})</div>
            <div class="atencion-lista">
            ${clientesNecesitanAtencion.map((c) => `
                  <div class="atencion-tarjeta">
                  <div class="tarjeta-nombre">${escaparHtml(c.nombre || "(sin nombre)")}</div>
                  <div class="tarjeta-tel">${escaparHtml(c.telefono)} · ${formatearFechaHora(c.ultimoContacto)}</div>
                  <div class="atencion-motivo">${escaparHtml(c.motivoAtencion || "El bot no pudo responderle.")}</div>
                  <a href="/admin/chat/${encodeURIComponent(c.telefono)}" style="color:#c0392b;font-weight:bold;">Ver / Responder</a>
                  <a href="/admin/atencion/${encodeURIComponent(c.telefono)}/resolver" onclick="return confirm('Marcar este chat como resuelto? Desaparecera de esta lista.');">Marcar como resuelto</a>
                  </div>`
                  ).join("")}
            </div>
            </div>`;

            const filasPedidos = pedidos
            .map(
                  (p) => `
                  <tr>
                  <td>${formatearFechaHora(p.fecha)}</td>
                  <td>${p.nombreCliente || ""}</td>
                  <td>${p.celular || ""}</td>
                  <td>${p.nombreProducto || ""}</td>
                  <td>${p.precio ? formatearPrecio(p.precio) : ""}</td>
                  <td>${p.departamento || ""} - ${p.ciudad || ""}</td>
                  <td>${p.direccion || ""} (${p.barrio || ""})</td>
                  <td>${p.medioPago || ""}</td>
                  </tr>`
                  )
            .join("");

            res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
            <meta charset="UTF-8">
            <title>Panel - Galviustech</title>
            <style>
            body { font-family: Arial, sans-serif; margin: 30px; background: #f7f7f7; }
            h1 { color: #222; }
            h2 { color: #222; margin-top: 40px; }
            table { border-collapse: collapse; width: 100%; background: white; }
            th, td { border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; }
            th { background: #222; color: white; }
            tr:nth-child(even) { background: #f2f2f2; }
            a { color: #0a6ed1; }
            .tablero { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 20px; }
            .columna { min-width: 220px; max-width: 220px; background: #eaeaea; border-radius: 8px; padding: 10px; flex-shrink: 0; }
            .columna-titulo { font-weight: bold; margin-bottom: 10px; font-size: 14px; }
            .contador { background: white; border-radius: 10px; padding: 1px 7px; font-size: 12px; margin-left: 4px; }
            .tarjeta { background: white; border-radius: 6px; padding: 8px; margin-bottom: 8px; font-size: 13px; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
            .tarjeta-nombre { font-weight: bold; }
            .tarjeta-tel { color: #666; font-size: 12px; margin-bottom: 4px; }
            .tarjeta a { display: block; margin-bottom: 6px; }
            .tarjeta select { width: 100%; font-size: 12px; padding: 3px; }
            .atencion-caja { background: #fdecea; border: 2px solid #c0392b; border-radius: 8px; padding: 14px; margin-bottom: 20px; }
            .atencion-titulo { font-weight: bold; font-size: 16px; color: #c0392b; margin-bottom: 10px; }
            .atencion-lista { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; }
            .atencion-tarjeta { background: white; border-radius: 6px; padding: 10px; min-width: 220px; max-width: 260px; flex-shrink: 0; font-size: 13px; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
            .atencion-tarjeta a { display: block; margin-top: 6px; font-size: 12px; }
            .atencion-motivo { color: #555; font-size: 12px; margin: 4px 0 6px 0; }
            </style>
            </head>
            <body>
            <h1>Panel - Galviustech</h1>
			<p><a href="/admin/reactivar" style="display:inline-block;background:#25D366;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Reactivar conversaciones pendientes</a>
			<a href="/admin/promo-diaria" style="display:inline-block;background:#e67e22;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;margin-left:8px;">Enviar promo del dia a todos</a>
			<a href="/admin/productos" style="display:inline-block;background:#0a6ed1;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;margin-left:8px;">Productos y precios</a></p>
			${req.query.promoDiariaEnviada !== undefined ? `<p style="color:#e67e22;font-weight:bold;">Promo del dia enviada a ${parseInt(req.query.promoDiariaEnviada, 10) || 0} cliente(s).</p>` : ""}
			${bloqueAtencion}
			<input type="text" id="buscador" onkeyup="filtrarClientes()" placeholder="Buscar por nombre o telefono..." style="width:100%;max-width:400px;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:10px;display:block;">
			<div style="margin-bottom:15px;">
			<a href="/admin?filtro=hoy&categoria=${categoriaActiva}" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "hoy" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Hoy</a>
			<a href="/admin?filtro=ayer&categoria=${categoriaActiva}" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "ayer" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Ayer</a>
			<a href="/admin?filtro=7dias&categoria=${categoriaActiva}" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "7dias" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Ultimos 7 dias</a>
			<a href="/admin?filtro=todos&categoria=${categoriaActiva}" style="padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "todos" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Todos</a>
			<button type="button" onclick="eliminarSeleccionados()" style="margin-left:12px;padding:6px 12px;border-radius:6px;font-size:13px;background:#c0392b;color:white;border:none;cursor:pointer;">Eliminar seleccionados</button>
			</div>
			<div style="margin-bottom:15px;">
			<span style="font-size:13px;color:#555;margin-right:6px;">Interes:</span>
			<a href="/admin?filtro=${filtroActivo}&categoria=todas" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${categoriaActiva === "todas" ? "background:#0a6ed1;color:white;" : "background:#eee;color:#222;"}">Todas</a>
			${categoriasDisponibles().map((cat) => `<a href="/admin?filtro=${filtroActivo}&categoria=${encodeURIComponent(cat)}" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${categoriaActiva === cat ? "background:#0a6ed1;color:white;" : "background:#eee;color:#222;"}">${infoCategoria(cat).emoji} ${infoCategoria(cat).titulo}</a>`).join("")}
			<a href="/admin?filtro=${filtroActivo}&categoria=combo" style="padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${categoriaActiva === "combo" ? "background:#0a6ed1;color:white;" : "background:#eee;color:#222;"}">🎁 Combos</a>
			</div>

            <h2>Clientes por etapa</h2>
            <div class="tablero">${columnas}</div>

            <h2>Pedidos confirmados (${pedidos.length})</h2>
            <table>
            <tr>
            <th>Fecha</th>
            <th>Cliente</th>
            <th>Celular</th>
            <th>Producto</th>
            <th>Precio</th>
            <th>Departamento / Ciudad</th>
            <th>Direccion</th>
            <th>Pago</th>
            </tr>
            ${filasPedidos}
            </table>
            <script>
			function filtrarClientes() {
			var q = document.getElementById("buscador").value.toLowerCase();
			var tarjetas = document.getElementsByClassName("tarjeta");
			for (var i = 0; i < tarjetas.length; i++) {
			var texto = tarjetas[i].textContent.toLowerCase();
			tarjetas[i].style.display = texto.indexOf(q) !== -1 ? "" : "none";
			}
			}
			function eliminarSeleccionados() {
			var checks = document.querySelectorAll(".check-eliminar:checked");
			if (checks.length === 0) {
			alert("Selecciona al menos un cliente");
			return;
			}
			if (!confirm("Seguro que quieres eliminar " + checks.length + " cliente(s)? Esta accion no se puede deshacer.")) {
			return;
			}
			var form = document.createElement("form");
			form.method = "POST";
			form.action = "/admin/eliminar-varios";
			for (var i = 0; i < checks.length; i++) {
			var input = document.createElement("input");
			input.type = "hidden";
			input.name = "telefonos";
			input.value = checks[i].value;
			form.appendChild(input);
			}
			document.body.appendChild(form);
			form.submit();
			}
			</script>
			</body>
            </html>
            `);
      } catch (error) {
            console.error("Error mostrando el panel:", error.response?.data || error.message);
            res.status(500).send("Hubo un error cargando el panel.");
      }
});

app.get("/admin/pausa/:telefono", requiereLogin, async (req, res) => {
      try {
            await alternarPausa(req.params.telefono);
            res.redirect("/admin");
      } catch (error) {
            console.error("Error alternando pausa:", error.response?.data || error.message);
            res.status(500).send("Hubo un error cambiando el estado del bot.");
      }
});

app.get("/admin/atencion/:telefono/resolver", requiereLogin, async (req, res) => {
      try {
            await marcarAtencionResuelta(req.params.telefono);
            res.redirect("/admin");
      } catch (error) {
            console.error("Error marcando atencion resuelta:", error.response?.data || error.message);
            res.status(500).send("Hubo un error actualizando el aviso.");
      }
});

app.post("/admin/etapa/:telefono", requiereLogin, async (req, res) => {
      try {
            const etapa = req.body.etapa || "auto";
            await alternarEtapa(req.params.telefono, etapa);
            res.redirect("/admin");
      } catch (error) {
            console.error("Error actualizando etapa:", error.response?.data || error.message);
            res.status(500).send("Hubo un error actualizando la etapa.");
      }
});

app.post("/admin/chat/:telefono/enviar", requiereLogin, (req, res) => {
      subirArchivoChat.single("archivo")(req, res, async (errorSubida) => {
            const volverConError = (mensajeError) =>
                  res.redirect(`/admin/chat/${encodeURIComponent(req.params.telefono)}?error=${encodeURIComponent(mensajeError)}`);

            if (errorSubida) {
                  console.error("Error subiendo archivo del chat:", errorSubida.message);
                  if (errorSubida.code === "LIMIT_FILE_SIZE") {
                        return volverConError("El archivo pesa mas de 16 MB, que es el maximo permitido. Comprimelo o envia uno mas liviano.");
                  }
                  return volverConError("Hubo un error subiendo el archivo. Intenta de nuevo.");
            }

            try {
                  const mensaje = (req.body.mensaje || "").trim();
                  if (req.file) {
                        await enviarArchivoManual(req.params.telefono, req.file, mensaje);
                  } else if (mensaje) {
                        await enviarMensajeManual(req.params.telefono, mensaje);
                  }
                  res.redirect(`/admin/chat/${encodeURIComponent(req.params.telefono)}`);
            } catch (error) {
                  console.error("Error enviando mensaje manual:", error.response?.data || error.message);
                  const mensajeError = error.esMensajeAmigable
                        ? error.message
                        : "Hubo un error enviando el mensaje. Intenta de nuevo.";
                  volverConError(mensajeError);
            }
      });
});

// Si por una recarga, doble clic o boton "atras" del navegador se termina pidiendo esta URL con
// GET (en vez de POST), evitamos el error crudo "Cannot GET" y devolvemos a la conversacion.
app.get("/admin/chat/:telefono/enviar", requiereLogin, (req, res) => {
      res.redirect(`/admin/chat/${encodeURIComponent(req.params.telefono)}`);
});

app.get("/admin/chat/:telefono", requiereLogin, async (req, res) => {
      try {
            const { datos: clientes } = await leerJSON(CLIENTES_API);
            const cliente = clientes.find((c) => c.telefono === req.params.telefono);

            if (!cliente) {
                  return res.status(404).send("Cliente no encontrado.");
            }

            const conversacion = cliente.conversacion || [];
            const burbujas = conversacion
            .map(
                  (m) => `
                  <div class="burbuja ${m.rol === "bot" ? "bot" : "cliente"}">
                  <div class="texto">${(m.texto || "").replace(/\n/g, "<br>")}</div>
                  <div class="hora">${formatearFechaHora(m.fecha)}${m.rol === "bot" ? iconoEstadoMensaje(m.estado) : ""}</div>
                  </div>`
                  )
            .join("");

            res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
            <meta charset="UTF-8">
            <title>Conversacion con ${cliente.nombre || cliente.telefono} - Galviustech</title>
            <style>
            body { font-family: Arial, sans-serif; margin: 0; background: #e5ddd5; padding-bottom: 90px; }
            .encabezado { background: #222; color: white; padding: 16px 24px; position: sticky; top: 0; }
            .encabezado a { color: #9fd3ff; text-decoration: none; }
            .chat { max-width: 700px; margin: 20px auto; padding: 0 16px; }
            .burbuja { max-width: 75%; margin-bottom: 10px; padding: 10px 14px; border-radius: 10px; font-size: 14px; }
            .burbuja.cliente { background: white; margin-right: auto; }
            .burbuja.bot { background: #dcf8c6; margin-left: auto; }
            .hora { font-size: 11px; color: #888; margin-top: 4px; text-align: right; }
            .check { font-size: 13px; margin-left: 4px; letter-spacing: -2px; }
            .check-leido { color: #53bdeb; }
            .check-fallido { color: #d32f2f; letter-spacing: normal; font-weight: bold; }
            .pausa { background: #fff3cd; padding: 10px 16px; text-align: center; font-size: 14px; }
            .escribir { position: fixed; bottom: 0; left: 0; right: 0; background: white; padding: 12px; display: flex; gap: 8px; align-items: center; max-width: 700px; margin: 0 auto; box-shadow: 0 -2px 6px rgba(0,0,0,0.1); }
            .escribir input[type="text"] { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
            .escribir label.adjuntar { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 18px; cursor: pointer; background: #f5f5f5; }
            .escribir input[type="file"] { display: none; }
            .escribir button { padding: 10px 18px; background: #25D366; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
            .archivo-nombre { font-size: 12px; color: #666; max-width: 700px; margin: 0 auto 6px; padding: 0 16px; }
            .aviso { max-width: 700px; margin: 10px auto; padding: 0 16px; font-size: 12px; color: #666; text-align: center; }
            .error-envio { max-width: 700px; margin: 10px auto; padding: 10px 16px; font-size: 13px; color: #842029; background: #f8d7da; border-radius: 6px; }
            </style>
            </head>
            <body>
            <div class="encabezado">
            <a href="/admin">&larr; Volver al panel</a>
            <h2>${cliente.nombre || "(sin nombre)"} - ${cliente.telefono}</h2>
            </div>
            ${req.query.error ? `<div class="error-envio">${escaparHtml(req.query.error)}</div>` : ""}
            <div class="pausa">
            Estado del bot: <strong>${cliente.pausado ? "Pausado" : "Activo"}</strong> -
            <a href="/admin/pausa/${encodeURIComponent(cliente.telefono)}">${cliente.pausado ? "Reanudar bot" : "Pausar bot"}</a>
            </div>
            <div class="chat">
            ${burbujas || "<p>Todavia no hay mensajes guardados de esta conversacion.</p>"}
            </div>
            <div class="aviso">${cliente.pausado ? "El bot esta pausado, tus mensajes se enviaran directamente al cliente." : "Al escribir aqui, el bot se pausara automaticamente para este cliente."}</div>
            <div class="archivo-nombre" id="nombreArchivo"></div>
            <form class="escribir" method="POST" action="/admin/chat/${encodeURIComponent(cliente.telefono)}/enviar" enctype="multipart/form-data">
            <label class="adjuntar" title="Adjuntar foto o video">
            📎
            <input type="file" name="archivo" accept="image/*,video/*" onchange="document.getElementById('nombreArchivo').textContent = this.files[0] ? 'Adjunto: ' + this.files[0].name : '';">
            </label>
            <input type="text" name="mensaje" id="campoMensaje" placeholder="Escribe tu mensaje o agrega una foto/video..." autocomplete="off">
            <button type="submit">Enviar</button>
            </form>
            <script>
            function irAlFinal() {
                  window.scrollTo(0, document.body.scrollHeight);
            }
            window.addEventListener("load", irAlFinal);
            document.getElementById("campoMensaje").addEventListener("focus", function () {
                  setTimeout(irAlFinal, 300);
            });
            </script>
            </body>
            </html>
            `);
      } catch (error) {
            console.error("Error mostrando conversacion:", error.response?.data || error.message);
            res.status(500).send("Hubo un error cargando la conversacion.");
      }
});

app.get("/webhook", (req, res) => {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === VERIFY_TOKEN) {
            return res.status(200).send(challenge);
      }
      return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
      try {
            // DIAGNOSTICO TEMPORAL (sep-2026): desde que se agrego la confirmacion de lectura
            // (checks estilo WhatsApp, commit e70dfab del 15-sep) NINGUNO de los 300+ mensajes del
            // bot enviados desde entonces llego a mostrar "entregado" ni "leido": todos se quedan
            // en un solo check para siempre. Como enviarTexto/enviarBotones/etc nunca tiran error
            // al mandar (Meta acepta el envio), la sospecha es que a este webhook nunca le esta
            // llegando el evento de "statuses" (recibo de entrega/lectura) de Meta, solo los
            // mensajes entrantes de los clientes. Este log deja ver, la proxima vez que llegue
            // cualquier payload que no sea un mensaje de texto/interactivo normal, exactamente que
            // trae, para poder confirmar si el problema es que Meta no esta mandando esos eventos
            // a esta URL (revisar la suscripcion de webhooks en Meta for Developers) o si los manda
            // en una forma distinta a la que este codigo espera. Quitar este log una vez resuelto.
            const entradas = Array.isArray(req.body.entry) ? req.body.entry : [];
            let seEncontroMensajeOEstado = false;

            for (const entry of entradas) {
                  const cambios = Array.isArray(entry.changes) ? entry.changes : [];
                  for (const change of cambios) {
                        const estadosDeEsteCambio = change?.value?.statuses;
                        if (estadosDeEsteCambio && estadosDeEsteCambio.length > 0) {
                              seEncontroMensajeOEstado = true;
                              console.log(
                                    "[diagnostico-checks] Llego evento de estado de mensaje:",
                                    JSON.stringify(estadosDeEsteCambio)
                                    );
                              for (const est of estadosDeEsteCambio) {
                                    await marcarEstadoMensaje(est.recipient_id, est.id, est.status);
                              }
                        }
                        if (change?.value?.messages?.[0]) {
                              seEncontroMensajeOEstado = true;
                        }
                  }
            }

            if (!seEncontroMensajeOEstado && entradas.length > 0) {
                  console.log(
                        "[diagnostico-checks] Webhook recibido sin messages ni statuses reconocidos:",
                        JSON.stringify(req.body)
                        );
            }

            // Si el unico contenido de este payload eran recibos de estado, ya se procesaron arriba
            // y no hay ningun mensaje entrante que responder.
            const entry = req.body.entry?.[0];
            const change = entry?.changes?.[0];
            const mensaje = change?.value?.messages?.[0];
            const estados = change?.value?.statuses;
            if (estados && estados.length > 0) {
                  return res.sendStatus(200);
            }

            if (!mensaje) {
                  return res.sendStatus(200);
            }

            const telefono = mensaje.from;
            const nombreCliente = change.value.contacts?.[0]?.profile?.name;

            if (!telefono) {
                  // Sin numero de telefono no hay a quien responder: WhatsApp rechaza cualquier
                  // envio con "(#100) The parameter to is required". Se ignora este mensaje en
                  // vez de intentar procesarlo, dejando registro del payload para revisarlo.
                  console.error("Webhook recibido sin numero de telefono (mensaje.from vacio):", JSON.stringify(mensaje));
                  return res.sendStatus(200);
            }

            await conColaPorTelefono(telefono, async () => {
                  await cargarSesionSiNueva(telefono);
                  const sesionActual = obtenerSesion(telefono);

                  if (sesionActual.pausado) {
                        if (mensaje.type === "text") {
                              registrarMensaje(telefono, "cliente", mensaje.text.body);
                        } else if (mensaje.type === "interactive") {
                              const tituloBoton =
                                    mensaje.interactive?.button_reply?.title || mensaje.interactive?.list_reply?.title;
                              registrarMensaje(telefono, "cliente", `[Selecciono] ${tituloBoton || ""}`);
                        }
                        guardarCliente(telefono, nombreCliente);
                        return;
                  }

                  if (mensaje.type === "text") {
                        const texto = mensaje.text.body;
                        registrarMensaje(telefono, "cliente", texto);
                        const sesion = obtenerSesion(telefono);
                        if (sesion.paso === "inicio") {
                              const especifico = detectarProductoEspecifico(texto);
                              const deteccion = detectarProductoPorPalabraClave(texto);
                              sesion.paso = "conversando";
                              // En el PRIMER mensaje (normalmente el texto automatico de un anuncio, ej.
                              // "Quiero mas informacion de Impresora termica") nunca saltamos directo a
                              // mostrar fotos+precio+boton de compra: es demasiado de golpe para alguien
                              // que recien hizo clic en un anuncio y todavia no genera ninguna confianza.
                              // En vez de manejarSeleccionProducto (que cierra con "quieres pedirlo?"),
                              // usamos el mismo camino que ya funciona bien para categorias (fotos +
                              // caracteristicas + UNA pregunta de descubrimiento antes de pedir la venta).
                              const categoriaDelEspecifico = especifico
                                    ? (catalogo.find((p) => p.id === especifico)?.categoria || "").trim().toLowerCase()
                                    : null;
                              if (categoriaDelEspecifico) {
                                    await enviarInfoCategoria(telefono, categoriaDelEspecifico);
                              } else if (especifico) {
                                    await manejarSeleccionProducto(telefono, especifico);
                              } else if (deteccion) {
                                    await enviarInfoCategoria(telefono, deteccion);
                              } else {
                                    await manejarSaludo(telefono, nombreCliente);
                              }
                        } else {
                              await manejarTextoLibre(telefono, texto);
                        }
                  }

                  if (mensaje.type === "interactive") {
                        const idBoton =
                              mensaje.interactive?.button_reply?.id || mensaje.interactive?.list_reply?.id;
                        const tituloBoton =
                              mensaje.interactive?.button_reply?.title || mensaje.interactive?.list_reply?.title;
                        registrarMensaje(telefono, "cliente", `[Selecciono] ${tituloBoton || idBoton}`);

                        if (idBoton?.startsWith("cat_")) {
                              await enviarInfoCategoria(telefono, idBoton.replace("cat_", ""));
                        } else if (idBoton === "ver_catalogo") {
                              await enviarListaCatalogo(telefono);
                        } else if (idBoton === "ver_combos") {
                              await enviarListaCombos(telefono);
                        } else if (idBoton?.startsWith("combo_")) {
                              const [comboId] = idBoton.replace("combo_", "").split("_");
                              await iniciarPedido(telefono, comboId);
                        } else if (idBoton?.startsWith("pedirfinal_")) {
                              await iniciarPedido(telefono, idBoton.replace("pedirfinal_", ""));
                        } else if (idBoton?.startsWith("producto_")) {
                              await manejarSeleccionProducto(telefono, idBoton.replace("producto_", ""));
                        } else if (idBoton?.startsWith("pedir_")) {
                              const pid = idBoton.replace("pedir_", "");
                              if (pid.startsWith("combo-")) {
                                    await iniciarPedido(telefono, pid);
                              } else {
                                    await ofrecerComboPromocion(telefono, pid);
                              }
                        } else {
                              // RESPALDO CONTRA SILENCIO TOTAL: si llega un boton/opcion de lista con
                              // un id que no coincide con ninguna de las ramas de arriba (por ejemplo un
                              // boton viejo de una conversacion de hace dias, o un id inesperado), antes
                              // no se le respondia nada al cliente. Mismo criterio que se aplico para
                              // manejarTextoLibre (ver RESPALDO CONTRA SILENCIO TOTAL mas abajo): mejor
                              // avisarle algo y escalar, que dejarlo sin ninguna respuesta.
                              console.error(`Boton/opcion sin manejar para ${telefono}: id="${idBoton}" titulo="${tituloBoton}"`);
                              sesionActual.necesitaAtencion = true;
                              sesionActual.motivoAtencion = `El cliente selecciono una opcion que el bot no supo procesar: "${tituloBoton || idBoton}"`;
                              await enviarTexto(
                                    telefono,
                                    "Disculpa, no pude procesar esa opcion. Cuentame directamente que necesitas y te ayudo."
                                    );
                        }
                  }

                  await guardarCliente(telefono, nombreCliente);
                  await limpiarClientesAntiguos();
                  await enviarRecordatoriosPendientes();
                  await enviarPromoDiariaAutomatica();
            });

            res.sendStatus(200);
      } catch (error) {
            console.error("Error procesando mensaje:", error.response?.data || error.message);
            res.sendStatus(200);
      }
});

// Guarda la bandera "reactivado" directamente sobre la version MAS RECIENTE de clientes.json (no
// sobre la copia que se leyo al principio de reactivarConversaciones, que para cuando termina de
// mandarle el mensaje a los 100+ clientes ya puede estar vieja). Se hace en un paso aparte, por
// cola, para no bloquear el resto de escrituras (por ejemplo los "chulos" de leido) durante todo
// el rato que toma enviar los mensajes uno por uno.
async function marcarReactivados(telefonos) {
	if (telefonos.length === 0) return;
	await conColaDeArchivo(CLIENTES_API, async () => {
	let intentosRestantes = 4;
	while (true) {
	try {
		const { datos, sha } = await leerJSON(CLIENTES_API);
		let cambios = false;
		for (const telefono of telefonos) {
			const cliente = datos.find((c) => c.telefono === telefono);
			if (cliente && !cliente.reactivado) {
				cliente.reactivado = true;
				cambios = true;
			}
		}
		if (!cambios) return;
		await guardarJSON(CLIENTES_API, datos, sha, "Conversaciones reactivadas manualmente");
		return;
	} catch (error) {
		const esConflicto = error.response?.status === 409 || error.response?.status === 422;
		if (esConflicto && intentosRestantes > 0) {
			intentosRestantes--;
			continue;
		}
		console.error(
			"Error guardando banderas de reactivacion (los mensajes ya se enviaron; no se repetiran en lo que dure este proceso):",
			error.response?.data || error.message
			);
		return;
	}
	}
	});
}

async function reactivarConversaciones() {
	let reactivados = 0;
	try {
		const { datos } = await leerJSON(CLIENTES_API);
		const { datos: pedidos } = await leerJSON(PEDIDOS_API);
		const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
		const telefonosReactivados = [];

		for (const c of datos) {
			if (c.pausado) continue;
			if (telefonosConPedido.has(c.telefono)) continue;
			if (c.reactivado) continue;
			if (!c.conversacion || c.conversacion.length === 0) continue;

			try {
				// Mismo bug que en enviarRecordatoriosPendientes y ejecutarPromoDiaria: cargar la
				// sesion real antes de enviar, para no crear una sesion en blanco que despues
				// sobreescriba el historial real del cliente.
				await cargarSesionSiNueva(c.telefono);
				await enviarTexto(c.telefono, config.mensajeReactivacion);
				telefonosReactivados.push(c.telefono);
				reactivados++;
			} catch (errorEnvio) {
				console.error(`Error reactivando a ${c.telefono}:`, errorEnvio.response?.data || errorEnvio.message);
			}
		}

		await marcarReactivados(telefonosReactivados);
	} catch (error) {
		console.error("Error reactivando conversaciones:", error.response?.data || error.message);
	}
	return reactivados;
}

app.get("/admin/reactivar", requiereLogin, async (req, res) => {
	try {
		await reactivarConversaciones();
		res.redirect("/admin");
	} catch (error) {
		console.error("Error en ruta de reactivacion:", error.response?.data || error.message);
		res.status(500).send("Hubo un error reactivando las conversaciones.");
	}
});

app.get("/admin/promo-diaria", requiereLogin, async (req, res) => {
	try {
		const cantidad = await ejecutarPromoDiaria();
		res.redirect(`/admin?promoDiariaEnviada=${cantidad}`);
	} catch (error) {
		console.error("Error en ruta de promo diaria:", error.response?.data || error.message);
		res.status(500).send("Hubo un error enviando la promocion diaria.");
	}
});

app.get("/admin/eliminar/:telefono", requiereLogin, async (req, res) => {
	try {
		await conColaDeArchivo(CLIENTES_API, async () => {
			const { datos, sha } = await leerJSON(CLIENTES_API);
			const datosFiltrados = datos.filter((c) => c.telefono !== req.params.telefono);
			if (datosFiltrados.length !== datos.length) {
				delete sesiones[req.params.telefono];
				await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Cliente eliminado manualmente");
			}
		});
		res.redirect("/admin");
	} catch (error) {
		console.error("Error eliminando cliente:", error.response?.data || error.message);
		res.status(500).send("Hubo un error eliminando el cliente.");
	}
});

app.post("/admin/eliminar-varios", requiereLogin, async (req, res) => {
	try {
		let telefonos = req.body.telefonos || [];
		if (!Array.isArray(telefonos)) telefonos = [telefonos];
		const telefonosSet = new Set(telefonos);
		await conColaDeArchivo(CLIENTES_API, async () => {
			const { datos, sha } = await leerJSON(CLIENTES_API);
			const datosFiltrados = datos.filter((c) => !telefonosSet.has(c.telefono));
			if (datosFiltrados.length !== datos.length) {
				for (const telefono of telefonosSet) delete sesiones[telefono];
				await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Clientes eliminados manualmente en lote");
			}
		});
		res.redirect("/admin");
	} catch (error) {
		console.error("Error eliminando clientes en lote:", error.response?.data || error.message);
		res.status(500).send("Hubo un error eliminando los clientes.");
	}
});

function estiloPaginaProductos(titulo) {
	return `
	<!DOCTYPE html>
	<html lang="es">
	<head>
	<meta charset="UTF-8">
	<title>${titulo} - Galviustech</title>
	<style>
	body { font-family: Arial, sans-serif; margin: 30px; background: #f7f7f7; }
	h1 { color: #222; }
	a { color: #0a6ed1; }
	table { border-collapse: collapse; width: 100%; background: white; margin-top: 15px; }
	th, td { border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; vertical-align: top; }
	th { background: #222; color: white; }
	tr:nth-child(even) { background: #f2f2f2; }
	.boton { display: inline-block; background: #25D366; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; border: none; cursor: pointer; }
	.boton-secundario { display: inline-block; background: #eee; color: #222; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; }
	.form-campo { margin-bottom: 14px; max-width: 600px; }
	.form-campo label { display: block; font-weight: bold; margin-bottom: 4px; font-size: 14px; }
	.form-campo input, .form-campo textarea { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
	.form-campo textarea { min-height: 80px; font-family: Arial, sans-serif; }
	.ayuda { color: #666; font-size: 12px; margin-top: 4px; }
	.acciones a, .acciones button { margin-right: 10px; }
	</style>
	</head>
	<body>`;
}

app.get("/admin/productos", requiereLogin, async (req, res) => {
	try {
		const { datos: productos } = await leerJSON(CATALOGO_API);
		const filas = productos
			.map(
				(p) => `
				<tr>
				<td>${p.nombre || ""}${p.nombreCorto ? `<br><span style="color:#666;font-size:12px;">${p.nombreCorto}</span>` : ""}</td>
				<td>${p.id.startsWith("combo-") ? "Combo" : (p.categoria || "<span style=\"color:#999;\">(sin categoria)</span>")}</td>
				<td>${formatearPrecio(p.precio || 0)}</td>
				<td>${p.color || ""}</td>
				<td>${(p.imagenes || []).length} imagen(es)${p.video ? " + video" : ""}</td>
				<td class="acciones">
				<a href="/admin/productos/${encodeURIComponent(p.id)}/editar">Editar</a>
				<a href="/admin/productos/${encodeURIComponent(p.id)}/eliminar" onclick="return confirm('Eliminar el producto \\'${(p.nombre || p.id).replace(/'/g, "")}\\'? Esta accion no se puede deshacer.');" style="color:#c0392b;">Eliminar</a>
				</td>
				</tr>`
			)
			.join("");

		res.send(`
		${estiloPaginaProductos("Productos y precios")}
		<p><a href="/admin">&larr; Volver al panel</a></p>
		<h1>Productos y precios</h1>
		<p><a href="/admin/productos/nuevo" class="boton">+ Agregar producto</a></p>
		<table>
		<tr>
		<th>Producto</th>
		<th>Categoria</th>
		<th>Precio</th>
		<th>Color</th>
		<th>Multimedia</th>
		<th>Acciones</th>
		</tr>
		${filas || "<tr><td colspan=\"6\">Todavia no hay productos en el catalogo.</td></tr>"}
		</table>
		</body>
		</html>
		`);
	} catch (error) {
		console.error("Error mostrando productos:", error.response?.data || error.message);
		res.status(500).send("Hubo un error cargando los productos.");
	}
});

function formularioProducto(producto, accion, tituloBoton, categoriasExistentes) {
	const p = producto || {};
	const opcionesCategoria = (categoriasExistentes || [])
		.map((c) => `<option value="${c.replace(/"/g, "&quot;")}">`)
		.join("");
	return `
	<div class="form-campo">
	<label>Nombre completo</label>
	<input type="text" name="nombre" value="${(p.nombre || "").replace(/"/g, "&quot;")}" required>
	</div>
	<div class="form-campo">
	<label>Nombre corto (como se muestra en botones/lista)</label>
	<input type="text" name="nombreCorto" value="${(p.nombreCorto || "").replace(/"/g, "&quot;")}">
	</div>
	<div class="form-campo">
	<label>Precio (COP)</label>
	<input type="text" name="precio" value="${p.precio || ""}" placeholder="Ej: 239900" required>
	<div class="ayuda">Escribe solo numeros, sin puntos ni simbolo de pesos.</div>
	</div>
	<div class="form-campo">
	<label>Categoria</label>
	<input type="text" name="categoria" list="lista-categorias" value="${(p.categoria || "").replace(/"/g, "&quot;")}" placeholder="Ej: modem, impresora, lampara, camara">
	<datalist id="lista-categorias">${opcionesCategoria}</datalist>
	<div class="ayuda">Agrupa productos parecidos (ej: "lampara") para que el bot los ofrezca juntos en el saludo inicial. Dejalo vacio si es un producto combo/promocion.</div>
	</div>
	<div class="form-campo">
	<label>Color</label>
	<input type="text" name="color" value="${(p.color || "").replace(/"/g, "&quot;")}">
	</div>
	<div class="form-campo">
	<label>Descripcion</label>
	<textarea name="descripcion">${(p.descripcion || "").replace(/</g, "&lt;")}</textarea>
	</div>
	<div class="form-campo">
	<label>Imagenes (una URL por linea)</label>
	<textarea name="imagenes">${(p.imagenes || []).join("\n")}</textarea>
	<div class="ayuda">Deben ser links directos a imagenes ya subidas (por ejemplo a GitHub). Este formulario no sube archivos.</div>
	</div>
	<div class="form-campo">
	<label>Video (URL, opcional)</label>
	<input type="text" name="video" value="${(p.video || "").replace(/"/g, "&quot;")}">
	</div>
	<button type="submit" class="boton">${tituloBoton}</button>
	<a href="/admin/productos" class="boton-secundario">Cancelar</a>
	`;
}

function categoriasExistentesDeCatalogo(datos) {
	const vistas = new Set();
	const lista = [];
	for (const p of datos) {
		const cat = (p.categoria || "").trim();
		if (!cat || vistas.has(cat.toLowerCase())) continue;
		vistas.add(cat.toLowerCase());
		lista.push(cat);
	}
	return lista;
}

app.get("/admin/productos/nuevo", requiereLogin, async (req, res) => {
	try {
		const { datos } = await leerJSON(CATALOGO_API);
		res.send(`
		${estiloPaginaProductos("Nuevo producto")}
		<p><a href="/admin/productos">&larr; Volver a productos</a></p>
		<h1>Agregar producto</h1>
		<form method="POST" action="/admin/productos/nuevo">
		${formularioProducto(null, "/admin/productos/nuevo", "Guardar producto", categoriasExistentesDeCatalogo(datos))}
		</form>
		</body>
		</html>
		`);
	} catch (error) {
		console.error("Error mostrando formulario de producto nuevo:", error.response?.data || error.message);
		res.status(500).send("Hubo un error cargando el formulario.");
	}
});

app.post("/admin/productos/nuevo", requiereLogin, async (req, res) => {
	try {
		const { datos, sha } = await leerJSON(CATALOGO_API);
		const nombre = (req.body.nombre || "").trim();
		if (!nombre) {
			return res.status(400).send("El nombre del producto es obligatorio.");
		}
		const nuevoProducto = {
			id: generarIdProducto(nombre, datos.map((p) => p.id)),
			nombre,
			nombreCorto: (req.body.nombreCorto || "").trim() || nombre,
			precio: parsearPrecio(req.body.precio),
			categoria: (req.body.categoria || "").trim(),
			color: (req.body.color || "").trim(),
			descripcion: (req.body.descripcion || "").trim(),
			imagenes: parsearLineas(req.body.imagenes),
		};
		const video = (req.body.video || "").trim();
		if (video) nuevoProducto.video = video;

		const nuevoCatalogo = [...datos, nuevoProducto];
		await guardarJSON(CATALOGO_API, nuevoCatalogo, sha, `Producto agregado: ${nombre}`);
		actualizarCatalogoEnMemoria(nuevoCatalogo);
		res.redirect("/admin/productos");
	} catch (error) {
		console.error("Error agregando producto:", error.response?.data || error.message);
		res.status(500).send("Hubo un error guardando el producto.");
	}
});

app.get("/admin/productos/:id/editar", requiereLogin, async (req, res) => {
	try {
		const { datos } = await leerJSON(CATALOGO_API);
		const producto = datos.find((p) => p.id === req.params.id);
		if (!producto) {
			return res.status(404).send("Producto no encontrado.");
		}
		res.send(`
		${estiloPaginaProductos("Editar producto")}
		<p><a href="/admin/productos">&larr; Volver a productos</a></p>
		<h1>Editar producto</h1>
		<form method="POST" action="/admin/productos/${encodeURIComponent(producto.id)}/editar">
		${formularioProducto(producto, `/admin/productos/${encodeURIComponent(producto.id)}/editar`, "Guardar cambios", categoriasExistentesDeCatalogo(datos))}
		</form>
		</body>
		</html>
		`);
	} catch (error) {
		console.error("Error mostrando formulario de edicion:", error.response?.data || error.message);
		res.status(500).send("Hubo un error cargando el producto.");
	}
});

app.post("/admin/productos/:id/editar", requiereLogin, async (req, res) => {
	try {
		const { datos, sha } = await leerJSON(CATALOGO_API);
		const indice = datos.findIndex((p) => p.id === req.params.id);
		if (indice === -1) {
			return res.status(404).send("Producto no encontrado.");
		}
		const nombre = (req.body.nombre || "").trim();
		if (!nombre) {
			return res.status(400).send("El nombre del producto es obligatorio.");
		}
		const productoActualizado = {
			...datos[indice],
			nombre,
			nombreCorto: (req.body.nombreCorto || "").trim() || nombre,
			precio: parsearPrecio(req.body.precio),
			categoria: (req.body.categoria || "").trim(),
			color: (req.body.color || "").trim(),
			descripcion: (req.body.descripcion || "").trim(),
			imagenes: parsearLineas(req.body.imagenes),
		};
		const video = (req.body.video || "").trim();
		if (video) {
			productoActualizado.video = video;
		} else {
			delete productoActualizado.video;
		}

		const nuevoCatalogo = [...datos];
		nuevoCatalogo[indice] = productoActualizado;
		await guardarJSON(CATALOGO_API, nuevoCatalogo, sha, `Producto actualizado: ${nombre}`);
		actualizarCatalogoEnMemoria(nuevoCatalogo);
		res.redirect("/admin/productos");
	} catch (error) {
		console.error("Error actualizando producto:", error.response?.data || error.message);
		res.status(500).send("Hubo un error guardando los cambios.");
	}
});

app.get("/admin/productos/:id/eliminar", requiereLogin, async (req, res) => {
	try {
		const { datos, sha } = await leerJSON(CATALOGO_API);
		const nuevoCatalogo = datos.filter((p) => p.id !== req.params.id);
		if (nuevoCatalogo.length !== datos.length) {
			await guardarJSON(CATALOGO_API, nuevoCatalogo, sha, `Producto eliminado: ${req.params.id}`);
			actualizarCatalogoEnMemoria(nuevoCatalogo);
		}
		res.redirect("/admin/productos");
	} catch (error) {
		console.error("Error eliminando producto:", error.response?.data || error.message);
		res.status(500).send("Hubo un error eliminando el producto.");
	}
});

app.get("/", (req, res) => {
      res.send("Bot de Galviustech corriendo correctamente");
});

app.listen(PUERTO, () => {
      console.log(`Servidor escuchando en el puerto ${PUERTO}`);

      // Antes, enviarRecordatoriosPendientes() y enviarPromoDiariaAutomatica() SOLO se ejecutaban
      // como efecto secundario de un mensaje entrante en /webhook. Si no llegaba trafico de
      // clientes, los recordatorios de 2h/5h/8h/11h y la promo del dia simplemente no se
      // disparaban. Ambas funciones ya tienen su propio throttle interno (10 minutos y 1 vez por
      // dia respectivamente), asi que aqui les damos un reloj real para que se evaluen
      // periodicamente sin depender de que un cliente escriba primero.
      setInterval(() => {
            enviarRecordatoriosPendientes().catch((error) => {
                  console.error("Error en revision periodica de recordatorios:", error.response?.data || error.message);
            });
      }, 5 * 60 * 1000);

      setInterval(() => {
            enviarPromoDiariaAutomatica().catch((error) => {
                  console.error("Error en revision periodica de promo diaria:", error.response?.data || error.message);
            });
      }, 30 * 60 * 1000);
});


