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
    PORT = 3000,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

const sesiones = {};

function obtenerSesion(telefono) {
    if (!sesiones[telefono]) {
          sesiones[telefono] = { paso: "inicio", pedido: {} };
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

async function manejarSaludo(telefono, nombreCliente) {
    const sesion = obtenerSesion(telefono);
    sesion.paso = "menu";
    await enviarTexto(telefono, config.mensajeBienvenida(nombreCliente));
    await enviarBotones(telefono, "Que te gustaria hacer?", [
      { id: "ver_catalogo", titulo: "Ver catalogo" },
      { id: "hacer_pedido", titulo: "Hacer un pedido" },
      { id: "hablar_asesor", titulo: "Hablar con Michell" },
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

  await enviarTexto(
        telefono,
        `*${producto.nombre}*\n${formatearPrecio(producto.precio)}\nColor: ${producto.color}\n\n${producto.descripcion}`
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
    sesion.paso = "pedido_cantidad";
    sesion.pedido = { productoId };
    await enviarTexto(telefono, `Genial, elegiste *${producto.nombre}*. Cuantas unidades quieres?`);
}

async function manejarTextoLibre(telefono, texto) {
    const sesion = obtenerSesion(telefono);
    const textoLower = texto.toLowerCase();

  if (sesion.paso === "pedido_cantidad") {
        const cantidad = parseInt(texto.replace(/\D/g, ""), 10);
        if (!cantidad || cantidad <= 0) {
                await enviarTexto(telefono, "Por favor dime un numero de unidades, ej: 1, 2, 3...");
                return;
        }
        sesion.pedido.cantidad = cantidad;
        sesion.paso = "pedido_nombre";
        await enviarTexto(telefono, "Perfecto. A nombre de quien hacemos el pedido?");
        return;
  }

  if (sesion.paso === "pedido_nombre") {
        sesion.pedido.nombreCliente = texto;
        sesion.paso = "pedido_direccion";
        await enviarTexto(telefono, "Cual es la direccion de entrega (o ciudad si prefieres recoger)?");
        return;
  }

  if (sesion.paso === "pedido_direccion") {
        sesion.pedido.direccion = texto;
        sesion.paso = "menu";

      const producto = catalogo.find((p) => p.id === sesion.pedido.productoId);
        const total = producto.precio * sesion.pedido.cantidad;

      await enviarTexto(
              telefono,
              `Listo! Este es el resumen de tu pedido:\n\n` +
                `${producto.nombre} x${sesion.pedido.cantidad}\n` +
                `Total: ${formatearPrecio(total)}\n` +
                `Nombre: ${sesion.pedido.nombreCliente}\n` +
                `Entrega: ${sesion.pedido.direccion}\n\n` +
                `Michell va a confirmar tu pedido en breve por este mismo chat. Gracias por tu compra!`
            );
        sesion.pedido = {};
        return;
  }

  const coincidencia = catalogo.find((p) =>
        textoLower.includes(p.nombre.toLowerCase().split(" ")[1]?.toLowerCase() || p.nombre.toLowerCase())
                                       );

  if (coincidencia) {
        await manejarSeleccionProducto(telefono, coincidencia.id);
        return;
  }

  if (textoLower.includes("hola") || textoLower.includes("buenas")) {
        await manejarSaludo(telefono);
        return;
  }

  await enviarTexto(
        telefono,
        "No estoy seguro de haber entendido eso. Pero aqui tienes tus opciones:"
      );
    await enviarBotones(telefono, "Que te gustaria hacer?", [
      { id: "ver_catalogo", titulo: "Ver catalogo" },
      { id: "hacer_pedido", titulo: "Hacer un pedido" },
      { id: "hablar_asesor", titulo: "Hablar con Michell" },
        ]);
}

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
                      sesion.paso = "menu";
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

app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});
