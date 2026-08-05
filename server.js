require("dotenv").config();
const express = require("express");
const axios = require("axios");
const catalogo = require("./catalog.json");
const config = require("./config.js");

const app = express();
app.use(express.json());

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
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/pedidos.json`;

const sesiones = {};

function obtenerSesion(telefono) {
        if (!sesiones[telefono]) {
                  sesiones[telefono] = { paso: "inicio", pedido: {}, historial: [] };
        }
        return sesiones[telefono];
}

function formatearPrecio(numero) {
        return numero.toLocaleString("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0 });
}

async function enviarTexto(telefono, texto) {
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

async function enviarBotones(telefono, texto, botones) {
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
                                                                                                        title: p.nombre,
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

async function leerPedidos() {
      try {
            const respuesta = await axios.get(GITHUB_API, {
                  headers: { Authorization: `token ${GITHUB_TOKEN}` },
            });
            const contenido = Buffer.from(respuesta.data.content, "base64").toString("utf-8");
            return { pedidos: JSON.parse(contenido), sha: respuesta.data.sha };
      } catch (error) {
            if (error.response?.status === 404) {
                  return { pedidos: [], sha: null };
            }
            throw error;
      }
}

async function guardarPedido(pedido) {
      try {
            const { pedidos, sha } = await leerPedidos();
            pedidos.unshift({ ...pedido, fecha: new Date().toISOString() });

      const contenidoNuevo = Buffer.from(JSON.stringify(pedidos, null, 2)).toString("base64");

      await axios.put(
            GITHUB_API,
            {
                  message: "Nuevo pedido registrado",
                  content: contenidoNuevo,
                  sha: sha || undefined,
            },
            { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
            );
      } catch (error) {
            console.error("Error guardando pedido:", error.response?.data || error.message);
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

async function manejarSaludo(telefono, nombreCliente) {
      const sesion = obtenerSesion(telefono);
      sesion.paso = "conversando";
      await enviarTexto(telefono, config.mensajeBienvenida(nombreCliente));
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

await enviarTexto(
      telefono,
      `*${producto.nombre}*\n${formatearPrecio(producto.precio)}\n\n${producto.descripcion}`
      );
      await enviarBotones(telefono, "Quieres pedir este producto?", [
            { id: `pedir_${producto.id}`, titulo: "Si, quiero este" },
            { id: "ver_catalogo", titulo: "Ver otros" },
            { id: "hablar_asesor", titulo: "Preguntar algo" },
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

async function manejarTextoLibre(telefono, texto) {
      const sesion = obtenerSesion(telefono);

const manejado = await manejarFlujoPedido(telefono, texto);
      if (manejado) return;

try {
      const { mensajeVisible, productoId } = await preguntarleALaIA(sesion, texto);

      if (mensajeVisible) {
            await enviarTexto(telefono, mensajeVisible);
      }

      if (productoId) {
            const existe = catalogo.find((p) => p.id === productoId);
            if (existe) {
                  await iniciarPedido(telefono, productoId);
            }
      }
} catch (error) {
      console.error("Error consultando la IA:", error.response?.data || error.message);
      await enviarTexto(
            telefono,
            "Disculpa, tuve un problema para procesar tu mensaje. Puedes intentar de nuevo o prefieres ver el catalogo?"
            );
      await enviarBotones(telefono, "Tambien puedes:", [
            { id: "ver_catalogo", titulo: "Ver catalogo" },
            { id: "hablar_asesor", titulo: "Hablar con Michell" },
            ]);
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
            const { pedidos } = await leerPedidos();
            const filas = pedidos
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
      <title>Pedidos - Galviustech</title>
      <style>
      body { font-family: Arial, sans-serif; margin: 30px; background: #f7f7f7; }
      h1 { color: #222; }
      table { border-collapse: collapse; width: 100%; background: white; }
      th, td { border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; }
      th { background: #222; color: white; }
      tr:nth-child(even) { background: #f2f2f2; }
      </style>
      </head>
      <body>
      <h1>Pedidos - Galviustech</h1>
      <p>Total: ${pedidos.length} pedido(s)</p>
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
      ${filas}
      </table>
      </body>
      </html>
      `);
      } catch (error) {
            console.error("Error mostrando pedidos:", error.response?.data || error.message);
            res.status(500).send("Hubo un error cargando los pedidos.");
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

      if (mensaje.type === "text") {
            const texto = mensaje.text.body;
            const sesion = obtenerSesion(telefono);
            if (sesion.paso === "inicio") {
                  await manejarSaludo(telefono, nombreCliente);
            } else {
                  await manejarTextoLibre(telefono, texto);
            }
      }

      if (mensaje.type === "interactive") {
            const idBoton =
                  mensaje.interactive?.button_reply?.id || mensaje.interactive?.list_reply?.id;

            if (idBoton === "ver_catalogo") {
                  await enviarListaCatalogo(telefono);
            } else if (idBoton === "hacer_pedido") {
                  await enviarListaCatalogo(telefono);
            } else if (idBoton === "hablar_asesor") {
                  const sesion = obtenerSesion(telefono);
                  sesion.paso = "conversando";
                  await enviarTexto(telefono, config.mensajeAsesorHumano);
            } else if (idBoton?.startsWith("producto_")) {
                  await manejarSeleccionProducto(telefono, idBoton.replace("producto_", ""));
            } else if (idBoton?.startsWith("pedir_")) {
                  await iniciarPedido(telefono, idBoton.replace("pedir_", ""));
            }
      }

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
