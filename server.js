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
                  sesiones[telefono] = { paso: "inicio", pedido: {}, historial: [], transcripcion: [], pausado: false, ultimoProducto: null };
        }
        return sesiones[telefono];
}

async function cargarSesionSiNueva(telefono) {
        if (sesiones[telefono]) return;
        try {
                  const { datos } = await leerJSON(CLIENTES_API);
                  const cliente = datos.find((c) => c.telefono === telefono);
                  if (cliente && cliente.paso && cliente.paso !== "inicio") {
                              sesiones[telefono] = {
                                            paso: cliente.paso,
                                            pedido: cliente.pedido || {},
                                            historial: [],
                                            transcripcion: cliente.conversacion || [],
                                            pausado: !!cliente.pausado,
                                            ultimoProducto: cliente.pedido?.productoId || null,
                              };
                              return;
                  }
                  if (cliente && cliente.pausado) {
                              sesiones[telefono] = {
                                            paso: "conversando",
                                            pedido: {},
                                            historial: [],
                                            transcripcion: cliente.conversacion || [],
                                            pausado: true,
                                            ultimoProducto: null,
                              };
                              return;
                  }
        } catch (error) {
                  console.error("Error cargando sesion persistida:", error.response?.data || error.message);
        }
        obtenerSesion(telefono);
}

function registrarMensaje(telefono, rol, texto) {
        const sesion = obtenerSesion(telefono);
        sesion.transcripcion.push({ rol, texto, fecha: new Date().toISOString() });
        if (sesion.transcripcion.length > 200) {
                  sesion.transcripcion = sesion.transcripcion.slice(-200);
        }
}

function formatearPrecio(numero) {
        return numero.toLocaleString("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 });
}

async function enviarTexto(telefono, texto) {
      registrarMensaje(telefono, "bot", texto);
      await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "text",
                  text: { body: texto },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
}

async function enviarImagen(telefono, urlImagen, caption) {
      registrarMensaje(telefono, "bot", `[Imagen] ${caption || ""}`);
      await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "image",
                  image: { link: urlImagen, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
}

async function enviarVideo(telefono, urlVideo, caption) {
      registrarMensaje(telefono, "bot", `[Video] ${caption || ""}`);
      await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "video",
                  video: { link: urlVideo, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
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
            throw new Error("No se pudo subir el archivo a WhatsApp: " + JSON.stringify(datos));
      }
      return datos.id;
}

async function enviarImagenPorId(telefono, mediaId, caption) {
      registrarMensaje(telefono, "bot", `[Imagen] ${caption || ""}`);
      await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "image",
                  image: { id: mediaId, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
}

async function enviarVideoPorId(telefono, mediaId, caption) {
      registrarMensaje(telefono, "bot", `[Video] ${caption || ""}`);
      await axios.post(
            GRAPH_URL,
            {
                  messaging_product: "whatsapp",
                  to: telefono,
                  type: "video",
                  video: { id: mediaId, caption: caption || "" },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
}

async function enviarBotones(telefono, texto, botones) {
      const listaBotones = botones.map((b) => b.titulo).join(" | ");
      registrarMensaje(telefono, "bot", `${texto}\n[Opciones: ${listaBotones}]`);
      await axios.post(
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
}

async function enviarListaCatalogo(telefono) {
      registrarMensaje(telefono, "bot", "[Envio el catalogo de productos]");
      await axios.post(
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
}

// Metadata de las categorias de producto que el catalogo puede tener. Nueva
// categoria = agregar aqui (opcional: si no esta aqui, igual funciona con
// valores por defecto en infoCategoria()).
const CATEGORIA_INFO = {
      modem: {
            titulo: "Modem",
            emoji: "📶",
            palabras: ["modem", "módem", "internet", "wifi", "wi-fi"],
            resumen:
                  "*Nuestros Modems WiFi Portatiles*\n\n" +
                  "Compatibles con SIM de todos los operadores en Colombia (Claro, Movistar, Tigo, WOM, ETB)\n" +
                  "Conectan hasta 10 dispositivos al mismo tiempo\n" +
                  "Instalacion facil: insertas la SIM, enciendes y listo\n" +
                  "Bateria recargable\n" +
                  "Ideales para hogar, oficina, estudio, viajes y zonas rurales con cobertura movil\n" +
                  "Garantia de 30 dias y soporte de GalviusTech",
            pregunta: "Para recomendarte el modem ideal, cuentame: lo necesitas para una zona rural (vereda) o para la ciudad? Y en que ciudad o municipio estas?",
      },
      impresora: {
            titulo: "Impresora",
            emoji: "🖨️",
            palabras: ["impresora", "imprimir"],
            resumen: null,
            pregunta: "Cuentame, para que la necesitas: negocio, tienda, restaurante, domicilios u otro uso? Y en que ciudad estas?",
      },
      lampara: {
            titulo: "Lamparas",
            emoji: "💡",
            palabras: ["lampara", "lámpara", "linterna", "panel solar", "luz solar"],
            resumen: null,
            pregunta: "Cuentame, la necesitas para tu casa, finca o negocio? Y en que ciudad estas?",
      },
      camara: {
            titulo: "Camaras",
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
      const info = infoCategoria(categoria);
      registrarMensaje(telefono, "bot", `[Envio fotos y caracteristicas: ${info.titulo}]`);

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

      for (const combo of combos) {
            if (combo.imagenes && combo.imagenes[0]) {
                  await enviarImagen(telefono, combo.imagenes[0], combo.nombreCorto);
            }
      }

      const lineasOfertas = combos
            .map((combo) => `🎁 *${combo.nombre}* por solo ${formatearPrecio(combo.precio)}`)
            .join("\n\n");

      await enviarTexto(
            telefono,
            "Antes de confirmar tu pedido... 🎁\n\n" +
            `Por tiempo limitado puedes llevar:\n\n${lineasOfertas}\n\n` +
            "Te animas a aprovechar alguna promocion?"
            );

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
            const contenido = Buffer.from(respuesta.data.content, "base64").toString("utf-8");
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

async function guardarPedido(pedido) {
      try {
            const { datos, sha } = await leerJSON(PEDIDOS_API);
            datos.unshift({ ...pedido, fecha: new Date().toISOString() });
            await guardarJSON(PEDIDOS_API, datos, sha, "Nuevo pedido registrado");
      } catch (error) {
            console.error("Error guardando pedido:", error.response?.data || error.message);
      }
}

async function guardarCliente(telefono, nombreCliente) {
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
            });
      }

      await guardarJSON(CLIENTES_API, datos, sha, "Registro de cliente actualizado");
      } catch (error) {
            console.error("Error guardando cliente:", error.response?.data || error.message);
      }
}

async function alternarPausa(telefono) {
      const { datos, sha } = await leerJSON(CLIENTES_API);
      const cliente = datos.find((c) => c.telefono === telefono);
      if (!cliente) return null;
      cliente.pausado = !cliente.pausado;
      await guardarJSON(CLIENTES_API, datos, sha, "Pausa de bot actualizada");
      if (sesiones[telefono]) {
            sesiones[telefono].pausado = cliente.pausado;
      }
      return cliente.pausado;
}

async function alternarEtapa(telefono, etapa) {
      const { datos, sha } = await leerJSON(CLIENTES_API);
      const cliente = datos.find((c) => c.telefono === telefono);
      if (!cliente) return;
      cliente.etapaManual = etapa === "auto" ? null : etapa;
      await guardarJSON(CLIENTES_API, datos, sha, "Etapa de cliente actualizada");
}

async function enviarMensajeManual(telefono, texto) {
      const sesion = obtenerSesion(telefono);
      sesion.pausado = true;
      await enviarTexto(telefono, texto);
      await guardarCliente(telefono);
}

async function enviarArchivoManual(telefono, archivo, caption) {
      const sesion = obtenerSesion(telefono);
      sesion.pausado = true;
      const mediaId = await subirMediaWhatsApp(archivo.buffer, archivo.mimetype);
      if (archivo.mimetype.startsWith("image/")) {
            await enviarImagenPorId(telefono, mediaId, caption);
      } else if (archivo.mimetype.startsWith("video/")) {
            await enviarVideoPorId(telefono, mediaId, caption);
      } else {
            throw new Error("Solo se permiten imagenes o videos.");
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
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const limiteMs = 5 * 24 * 60 * 60 * 1000;
            const cantidadOriginal = datos.length;
            const datosFiltrados = datos.filter((c) => {
                  const ultimo = new Date(c.ultimoContacto).getTime();
                  if (isNaN(ultimo)) return true;
                  return ahora - ultimo <= limiteMs;
            });
            if (datosFiltrados.length !== cantidadOriginal) {
                  for (const telefono of Object.keys(sesiones)) {
                        const sigueExistiendo = datosFiltrados.some((c) => c.telefono === telefono);
                        if (!sigueExistiendo) delete sesiones[telefono];
                  }
                  await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Eliminados clientes con mas de 5 dias sin contacto");
            }
      } catch (error) {
            console.error("Error eliminando clientes antiguos:", error.response?.data || error.message);
      }
}

async function preguntarleALaIA(sesion, mensajeCliente) {
      sesion.historial.push({ role: "user", content: mensajeCliente });
      if (sesion.historial.length > 16) {
            sesion.historial = sesion.historial.slice(-16);
      }

const respuesta = await axios.post(
      ANTHROPIC_URL,
      {
            model: ANTHROPIC_MODEL,
            max_tokens: 700,
            system: config.construirSystemPrompt(catalogo),
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

const bloques = respuesta.data.content || [];
      const textoCompleto = bloques
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

sesion.historial.push({ role: "assistant", content: textoCompleto });

const lineas = textoCompleto.split("\n");
      const ultimaLinea = lineas[lineas.length - 1].trim();
      const match = ultimaLinea.match(/^ACCION_PEDIDO:\s*(\S+)/i);

let mensajeVisible = textoCompleto;
      let productoId = null;

if (match) {
      productoId = match[1].trim();
      mensajeVisible = lineas.slice(0, -1).join("\n").trim();
}

return { mensajeVisible, productoId };
}

let ultimaRevisionRecordatorios = 0;

async function enviarRecordatoriosPendientes() {
      const ahora = Date.now();
      if (ahora - ultimaRevisionRecordatorios < 10 * 60 * 1000) return;
      ultimaRevisionRecordatorios = ahora;
      if (!estaEnHorarioComercial()) return;
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
            let cambios = false;

            for (const c of datos) {
                  if (c.pausado) continue;
                  if (telefonosConPedido.has(c.telefono)) continue;
                  if (!c.ultimoContacto) continue;
                  if (!c.recordatorios) c.recordatorios = {};

                  const transcurrido = ahora - new Date(c.ultimoContacto).getTime();
                  const productoId = c.pedido?.productoId || null;
                  const producto = productoId ? catalogo.find((p) => p.id === productoId) : null;
                  const nombreProducto = producto?.nombre || null;
                  const precioTexto = producto ? formatearPrecio(producto.precio) : null;

                  if (transcurrido >= 30 * 60 * 1000 && !c.recordatorios.min30) {
                        await enviarTexto(c.telefono, config.mensajeRecordatorio30Min(nombreProducto, precioTexto));
                        c.recordatorios.min30 = true;
                        cambios = true;
                  } else if (transcurrido >= 2 * 60 * 60 * 1000 && !c.recordatorios.horas2) {
                        await enviarTexto(c.telefono, config.mensajeRecordatorio2Horas(nombreProducto, precioTexto));
                        for (const combo of imagenesPromoParaProducto(productoId)) {
                              await enviarImagen(c.telefono, combo.imagenes[0], combo.nombreCorto || combo.nombre);
                        }
                        c.recordatorios.horas2 = true;
                        cambios = true;
                  } else if (transcurrido >= 6 * 60 * 60 * 1000 && !c.recordatorios.horas6) {
                        await enviarTexto(c.telefono, config.mensajeRemarketing6Horas(nombreProducto, precioTexto));
                        c.recordatorios.horas6 = true;
                        cambios = true;
                  } else if (transcurrido >= 18 * 60 * 60 * 1000 && !c.recordatorios.dias2) {
                        await enviarTexto(c.telefono, config.mensajeRemarketing2Dias(nombreProducto, precioTexto));
                        c.recordatorios.dias2 = true;
                        cambios = true;
                  }
            }

            if (cambios) {
                  await guardarJSON(CLIENTES_API, datos, sha, "Recordatorios de remarketing enviados");
            }
      } catch (error) {
            console.error("Error enviando recordatorios:", error.response?.data || error.message);
      }
}

async function enviarListaCategorias(telefono, categorias) {
      registrarMensaje(telefono, "bot", "[Envio menu de categorias]");
      await axios.post(
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
                                          rows: categorias.map((c) => {
                                                const info = infoCategoria(c);
                                                return {
                                                      id: `cat_${c}`,
                                                      title: `${info.emoji} ${info.titulo}`.slice(0, 24),
                                                };
                                          }),
                                    },
                                    ],
                        },
                  },
            },
            { headers: { Authorization: `Bearer ${META_TOKEN}` } }
            );
}

async function manejarSaludo(telefono, nombreCliente) {
      const sesion = obtenerSesion(telefono);
      sesion.paso = "conversando";
      const categorias = categoriasDisponibles();
      const titulos = categorias.map((c) => infoCategoria(c).titulo);
      await enviarTexto(telefono, config.mensajeBienvenida(nombreCliente, titulos));

      if (categorias.length === 0) {
            return;
      }
      if (categorias.length <= 3) {
            await enviarBotones(
                  telefono,
                  "Que te interesa?",
                  categorias.map((c) => ({ id: `cat_${c}`, titulo: infoCategoria(c).titulo.slice(0, 20) }))
                  );
      } else {
            await enviarListaCategorias(telefono, categorias);
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
      await enviarBotones(telefono, "Quieres pedir este producto?", [
            { id: `pedir_${producto.id}`, titulo: "Si, quiero este" },
            { id: "ver_catalogo", titulo: "Ver otros" },
            ]);
}

async function iniciarPedido(telefono, productoId) {
      const sesion = obtenerSesion(telefono);
      const producto = catalogo.find((p) => p.id === productoId);
      if (!producto) {
            await enviarTexto(telefono, "No encontre ese producto en el catalogo, puedes elegir otro?");
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

async function manejarFlujoPedido(telefono, texto) {
      const sesion = obtenerSesion(telefono);

      if (sesion.paso === "pedido_nombre") {
            sesion.pedido.nombreCliente = texto;
            sesion.paso = "pedido_celular";
            await enviarTexto(telefono, "Gracias. Cual es tu numero de celular?");
            return true;
      }

      if (sesion.paso === "pedido_celular") {
            sesion.pedido.celular = texto;
            sesion.paso = "pedido_departamento";
            await enviarTexto(telefono, "En que departamento vives?");
            return true;
      }

      if (sesion.paso === "pedido_departamento") {
            sesion.pedido.departamento = texto;
            sesion.paso = "pedido_ciudad";
            await enviarTexto(telefono, "Y en que ciudad o municipio?");
            return true;
      }

      if (sesion.paso === "pedido_ciudad") {
            sesion.pedido.ciudad = texto;
            sesion.paso = "pedido_direccion";
            await enviarTexto(telefono, "Cual es tu direccion completa?");
            return true;
      }

      if (sesion.paso === "pedido_direccion") {
            sesion.pedido.direccion = texto;
            sesion.paso = "pedido_barrio";
            await enviarTexto(telefono, "En que barrio queda esa direccion?");
            return true;
      }

      if (sesion.paso === "pedido_barrio") {
            sesion.pedido.barrio = texto;
            sesion.paso = "pedido_pago";
            await enviarTexto(telefono, "Por ultimo, que medio de pago prefieres? (contraentrega, transferencia u otro)");
            return true;
      }

      if (sesion.paso === "pedido_pago") {
            sesion.pedido.medioPago = texto;
            if (texto.toLowerCase().includes("transf")) {
                  await enviarTexto(telefono, config.mensajeDatosTransferencia);
            }
            await enviarTexto(telefono, config.mensajeResumenPedido(sesion.pedido));
            await guardarPedido(sesion.pedido);
            sesion.paso = "conversando";
            sesion.pedido = {};
            return true;
      }

      return false;
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


      try {
            const { mensajeVisible, productoId } = await preguntarleALaIA(sesion, texto);

            if (mensajeVisible) {
                  await enviarTexto(telefono, mensajeVisible);
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
                  }
            }
      } catch (error) {
            console.error("Error consultando la IA:", error.response?.data || error.message);
            await enviarTexto(
                  telefono,
                  "Disculpa, tuve un problema para procesar tu mensaje. Puedes intentar de nuevo?"
                  );
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
		  const clientesFiltrados = filtrarClientesPorFecha(clientes, filtroActivo);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));

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

            const filasPedidos = pedidos
            .map(
                  (p) => `
                  <tr>
                  <td>${new Date(p.fecha).toLocaleString("es-CO")}</td>
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
            </style>
            </head>
            <body>
            <h1>Panel - Galviustech</h1>
			<p><a href="/admin/reactivar" style="display:inline-block;background:#25D366;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Reactivar conversaciones pendientes</a>
			<a href="/admin/productos" style="display:inline-block;background:#0a6ed1;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;margin-left:8px;">Productos y precios</a></p>
			<input type="text" id="buscador" onkeyup="filtrarClientes()" placeholder="Buscar por nombre o telefono..." style="width:100%;max-width:400px;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:10px;display:block;">
			<div style="margin-bottom:15px;">
			<a href="/admin?filtro=hoy" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "hoy" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Hoy</a>
			<a href="/admin?filtro=ayer" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "ayer" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Ayer</a>
			<a href="/admin?filtro=7dias" style="margin-right:8px;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "7dias" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Ultimos 7 dias</a>
			<a href="/admin?filtro=todos" style="padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px;${filtroActivo === "todos" ? "background:#222;color:white;" : "background:#eee;color:#222;"}">Todos</a>
			<button type="button" onclick="eliminarSeleccionados()" style="margin-left:12px;padding:6px 12px;border-radius:6px;font-size:13px;background:#c0392b;color:white;border:none;cursor:pointer;">Eliminar seleccionados</button>
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

app.post("/admin/chat/:telefono/enviar", requiereLogin, subirArchivoChat.single("archivo"), async (req, res) => {
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
            res.status(500).send("Hubo un error enviando el mensaje. " + (error.message || ""));
      }
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
                  <div class="hora">${new Date(m.fecha).toLocaleString("es-CO")}</div>
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
            .pausa { background: #fff3cd; padding: 10px 16px; text-align: center; font-size: 14px; }
            .escribir { position: fixed; bottom: 0; left: 0; right: 0; background: white; padding: 12px; display: flex; gap: 8px; align-items: center; max-width: 700px; margin: 0 auto; box-shadow: 0 -2px 6px rgba(0,0,0,0.1); }
            .escribir input[type="text"] { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
            .escribir label.adjuntar { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 18px; cursor: pointer; background: #f5f5f5; }
            .escribir input[type="file"] { display: none; }
            .escribir button { padding: 10px 18px; background: #25D366; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
            .archivo-nombre { font-size: 12px; color: #666; max-width: 700px; margin: 0 auto 6px; padding: 0 16px; }
            .aviso { max-width: 700px; margin: 10px auto; padding: 0 16px; font-size: 12px; color: #666; text-align: center; }
            </style>
            </head>
            <body>
            <div class="encabezado">
            <a href="/admin">&larr; Volver al panel</a>
            <h2>${cliente.nombre || "(sin nombre)"} - ${cliente.telefono}</h2>
            </div>
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
            const entry = req.body.entry?.[0];
            const change = entry?.changes?.[0];
            const mensaje = change?.value?.messages?.[0];

            if (!mensaje) {
                  return res.sendStatus(200);
            }

            const telefono = mensaje.from;
            const nombreCliente = change.value.contacts?.[0]?.profile?.name;

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
                  return res.sendStatus(200);
            }

            if (mensaje.type === "text") {
                  const texto = mensaje.text.body;
                  registrarMensaje(telefono, "cliente", texto);
                  const sesion = obtenerSesion(telefono);
                  if (sesion.paso === "inicio") {
                        const especifico = detectarProductoEspecifico(texto);
                        const deteccion = detectarProductoPorPalabraClave(texto);
                        sesion.paso = "conversando";
                        if (especifico) {
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
                  }
            }

			await guardarCliente(telefono, nombreCliente);
              			await limpiarClientesAntiguos();
              			await enviarRecordatoriosPendientes();
              
            res.sendStatus(200);
      } catch (error) {
            console.error("Error procesando mensaje:", error.response?.data || error.message);
            res.sendStatus(200);
      }
});

async function reactivarConversaciones() {
	let reactivados = 0;
	try {
		const { datos, sha } = await leerJSON(CLIENTES_API);
		const { datos: pedidos } = await leerJSON(PEDIDOS_API);
		const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
		let cambios = false;
		
		for (const c of datos) {
			if (c.pausado) continue;
			if (telefonosConPedido.has(c.telefono)) continue;
			if (c.reactivado) continue;
			if (!c.conversacion || c.conversacion.length === 0) continue;
			
			try {
				await enviarTexto(c.telefono, config.mensajeReactivacion);
				c.reactivado = true;
				cambios = true;
				reactivados++;
			} catch (errorEnvio) {
				console.error(`Error reactivando a ${c.telefono}:`, errorEnvio.response?.data || errorEnvio.message);
			}
		}
		
		if (cambios) {
			await guardarJSON(CLIENTES_API, datos, sha, "Conversaciones reactivadas manualmente");
		}
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

app.get("/admin/eliminar/:telefono", requiereLogin, async (req, res) => {
	try {
		const { datos, sha } = await leerJSON(CLIENTES_API);
		const datosFiltrados = datos.filter((c) => c.telefono !== req.params.telefono);
		if (datosFiltrados.length !== datos.length) {
			delete sesiones[req.params.telefono];
			await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Cliente eliminado manualmente");
		}
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
		const { datos, sha } = await leerJSON(CLIENTES_API);
		const datosFiltrados = datos.filter((c) => !telefonosSet.has(c.telefono));
		if (datosFiltrados.length !== datos.length) {
			for (const telefono of telefonosSet) delete sesiones[telefono];
			await guardarJSON(CLIENTES_API, datosFiltrados, sha, "Clientes eliminados manualmente en lote");
		}
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
});


