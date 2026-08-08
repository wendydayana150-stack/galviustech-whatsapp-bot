require("dotenv").config();
const express = require("express");
const axios = require("axios");
const catalogo = require("./catalog.json");
const config = require("./config.js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
                                          rows: catalogo.map((p) => ({
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

async function enviarInfoModems(telefono) {
      registrarMensaje(telefono, "bot", "[Envio fotos y caracteristicas de modems]");
      const modems = catalogo.filter((p) => p.id.startsWith("modem"));
      for (const p of modems) {
            if (p.imagenes && p.imagenes[0]) {
                  await enviarImagen(telefono, p.imagenes[0], `${p.nombreCorto} - ${formatearPrecio(p.precio)}`);
            }
      }
      await enviarTexto(
            telefono,
            "*Nuestros Modems WiFi Portatiles*\n\n" +
            "Compatibles con SIM de todos los operadores en Colombia (Claro, Movistar, Tigo, WOM, ETB)\n" +
            "Conectan hasta 10 dispositivos al mismo tiempo\n" +
            "Instalacion facil: insertas la SIM, enciendes y listo\n" +
            "Bateria recargable\n" +
            "Ideales para hogar, oficina, estudio, viajes y zonas rurales con cobertura movil\n" +
            "Garantia de 30 dias y soporte de GalviusTech"
            );
      await enviarTexto(
            telefono,
            "Para recomendarte el modem ideal, cuentame: lo necesitas para una zona rural (vereda) o para la ciudad? Y en que ciudad o municipio estas?"
            );
}

async function enviarInfoImpresora(telefono) {
      const sesion = obtenerSesion(telefono);
      sesion.ultimoProducto = "impresora-termica";
      const producto = catalogo.find((p) => p.id === "impresora-termica");
      registrarMensaje(telefono, "bot", "[Envio fotos y caracteristicas de la impresora]");
      if (producto?.imagenes) {
            for (const url of producto.imagenes) {
                  await enviarImagen(telefono, url, producto.nombreCorto);
            }
      }
      await enviarTexto(
            telefono,
            `*${producto.nombre}*\n${formatearPrecio(producto.precio)}\n\n` +
            "No necesita tinta ni toner, ahorras dinero desde la primera impresion\n" +
            "Bluetooth, compatible con Android e iPhone\n" +
            "Portatil, bateria recargable, impresion rapida\n" +
            "Ideal para emprendedores, tiendas, restaurantes, mensajeros y oficinas\n" +
            "Imprime facturas, recibos, cotizaciones, etiquetas y guias\n" +
            "Garantia de 30 dias y soporte de GalviusTech"
            );
      await enviarTexto(
            telefono,
            "Cuentame, para que la necesitas: negocio, tienda, restaurante, domicilios u otro uso? Y en que ciudad estas?"
            );
}

async function ofrecerComboPromocion(telefono, productoIdOriginal) {
      const combo = catalogo.find((p) => p.id === "modem-smartwatch");
      if (!combo) {
            await iniciarPedido(telefono, productoIdOriginal);
            return;
      }
      if (combo.imagenes && combo.imagenes[0]) {
            await enviarImagen(telefono, combo.imagenes[0], "Promo especial");
      }
      await enviarTexto(
            telefono,
            "Antes de confirmar tu pedido... 🎁\n\n" +
            `Por tiempo limitado puedes llevar el *Modem WiFi Portatil + Reloj Smartwatch* de regalo por solo ${formatearPrecio(combo.precio)}.\n\n` +
            "Te llevas el mismo modem que ya viste, mas un reloj inteligente de regalo, por muy poquito mas.\n\n" +
            "Te animas a aprovechar la promocion?"
            );
      await enviarBotones(telefono, "Que prefieres?", [
            { id: `combosi_${productoIdOriginal}`, titulo: "Si, quiero el combo" },
            { id: `pedirfinal_${productoIdOriginal}`, titulo: "No, solo el modem" },
            ]);
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

function calcularEtapa(cliente, telefonosConPedido) {
      if (cliente.etapaManual) return cliente.etapaManual;
      if (cliente.pausado) return "No automatizado";
      if (telefonosConPedido.has(cliente.telefono)) return "Datos completados";
      const paso = cliente.paso || "inicio";
      if (paso.startsWith("pedido_") || paso === "esperando_confirmacion_envio") return "Cliente potencial";
      if (paso === "conversando" && (cliente.mensajes || 1) > 1) return "Interaccion con IA";
      return "Contacto inicial";
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
            system: config.SYSTEM_PROMPT,
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
      try {
            const { datos, sha } = await leerJSON(CLIENTES_API);
            const { datos: pedidos } = await leerJSON(PEDIDOS_API);
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));
            const precioImpresora = catalogo.find((p) => p.id === "impresora-termica")?.precio || 0;
            const precioTexto = formatearPrecio(precioImpresora);
            let cambios = false;

            for (const c of datos) {
                  if (c.pausado) continue;
                  if (telefonosConPedido.has(c.telefono)) continue;
                  if (!c.ultimoContacto) continue;
                  if (!c.recordatorios) c.recordatorios = {};

                  const transcurrido = ahora - new Date(c.ultimoContacto).getTime();

                  if (transcurrido >= 30 * 60 * 1000 && !c.recordatorios.min30) {
                        await enviarTexto(c.telefono, config.mensajeRecordatorio30Min(precioTexto));
                        c.recordatorios.min30 = true;
                        cambios = true;
                  } else if (transcurrido >= 2 * 60 * 60 * 1000 && !c.recordatorios.horas2) {
                        await enviarTexto(c.telefono, config.mensajeRecordatorio2Horas(precioTexto));
                        c.recordatorios.horas2 = true;
                        cambios = true;
                  } else if (transcurrido >= 18 * 60 * 60 * 1000 && !c.recordatorios.dias2) {
                        await enviarTexto(c.telefono, config.mensajeRemarketing2Dias(precioTexto));
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

async function manejarSaludo(telefono, nombreCliente) {
      const sesion = obtenerSesion(telefono);
      sesion.paso = "conversando";
      await enviarTexto(telefono, config.mensajeBienvenida(nombreCliente));
      await enviarBotones(telefono, "Que te interesa?", [
            { id: "cat_modem", titulo: "Modem" },
            { id: "cat_impresora", titulo: "Impresora" },
            ]);
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
            sesion.paso = "esperando_confirmacion_envio";
            if (texto.toLowerCase().includes("transf")) {
                  await enviarTexto(telefono, config.mensajeDatosTransferencia);
            }
            await enviarTexto(telefono, config.mensajeConfirmacionPedido);
            return true;
      }

      if (sesion.paso === "esperando_confirmacion_envio") {
            const textoLower = texto.toLowerCase();
            if (textoLower.includes("confirmo") || textoLower.includes("si")) {
                  await enviarTexto(telefono, config.mensajePedidoConfirmado);
                  await guardarPedido(sesion.pedido);
                  sesion.paso = "conversando";
                  sesion.pedido = {};
            } else {
                  await enviarTexto(
                        telefono,
                        "Sin problema, cuando quieras confirmar solo responde Si, confirmo y despachamos tu pedido."
                        );
            }
            return true;
      }

      return false;
}

function detectarProductoEspecifico(texto) {
      const t = texto.toLowerCase();
      if (t.includes("smartwatch") || t.includes("combo") || t.includes("reloj")) {
            return "modem-smartwatch";
      }
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
      if (t.includes("impresora") || t.includes("imprimir")) {
            return "impresora";
      }
      if (t.includes("modem") || t.includes("módem") || t.includes("internet") || t.includes("wifi") || t.includes("wi-fi")) {
            return "modem";
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

      if (sesion.historial.length === 0) {
            const especifico = detectarProductoEspecifico(texto);
            if (especifico) {
                  await manejarSeleccionProducto(telefono, especifico);
                  return;
            }

            const deteccion = detectarProductoPorPalabraClave(texto);
            if (deteccion === "impresora") {
                  await enviarInfoImpresora(telefono);
                  return;
            }
            if (deteccion === "modem") {
                  await enviarInfoModems(telefono);
                  return;
            }
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
                        if (productoId.startsWith("modem") && productoId !== "modem-smartwatch") {
                              await ofrecerComboPromocion(telefono, productoId);
                        } else {
                              await iniciarPedido(telefono, productoId);
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
            const telefonosConPedido = new Set(pedidos.map((p) => p.telefono));

            const grupos = {};
            ETAPAS.forEach((e) => {
                  grupos[e.id] = [];
            });
            clientes.forEach((c) => {
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
                        <div class="tarjeta-nombre">${c.nombre || "(sin nombre)"}</div>
                        <div class="tarjeta-tel">${c.telefono}</div>
                        <a href="/admin/chat/${encodeURIComponent(c.telefono)}">Ver / Escribir</a>
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

app.post("/admin/chat/:telefono/enviar", requiereLogin, async (req, res) => {
      try {
            const mensaje = (req.body.mensaje || "").trim();
            if (mensaje) {
                  await enviarMensajeManual(req.params.telefono, mensaje);
            }
            res.redirect(`/admin/chat/${encodeURIComponent(req.params.telefono)}`);
      } catch (error) {
            console.error("Error enviando mensaje manual:", error.response?.data || error.message);
            res.status(500).send("Hubo un error enviando el mensaje.");
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
            .escribir { position: fixed; bottom: 0; left: 0; right: 0; background: white; padding: 12px; display: flex; gap: 8px; max-width: 700px; margin: 0 auto; box-shadow: 0 -2px 6px rgba(0,0,0,0.1); }
            .escribir input { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
            .escribir button { padding: 10px 18px; background: #25D366; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
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
            <form class="escribir" method="POST" action="/admin/chat/${encodeURIComponent(cliente.telefono)}/enviar">
            <input type="text" name="mensaje" placeholder="Escribe tu mensaje..." autocomplete="off" required>
            <button type="submit">Enviar</button>
            </form>
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
                        } else if (deteccion === "impresora") {
                              await enviarInfoImpresora(telefono);
                        } else if (deteccion === "modem") {
                              await enviarInfoModems(telefono);
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

                  if (idBoton === "cat_modem") {
                        await enviarInfoModems(telefono);
                  } else if (idBoton === "cat_impresora") {
                        await enviarInfoImpresora(telefono);
                  } else if (idBoton === "ver_catalogo") {
                        await enviarListaCatalogo(telefono);
                  } else if (idBoton?.startsWith("combosi_")) {
                        await iniciarPedido(telefono, "modem-smartwatch");
                  } else if (idBoton?.startsWith("pedirfinal_")) {
                        await iniciarPedido(telefono, idBoton.replace("pedirfinal_", ""));
                  } else if (idBoton?.startsWith("producto_")) {
                        await manejarSeleccionProducto(telefono, idBoton.replace("producto_", ""));
                  } else if (idBoton?.startsWith("pedir_")) {
                        const pid = idBoton.replace("pedir_", "");
                        if (pid.startsWith("modem") && pid !== "modem-smartwatch") {
                              await ofrecerComboPromocion(telefono, pid);
                        } else {
                              await iniciarPedido(telefono, pid);
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

app.get("/", (req, res) => {
      res.send("Bot de Galviustech corriendo correctamente");
});

app.listen(PUERTO, () => {
      console.log(`Servidor escuchando en el puerto ${PUERTO}`);
});


