// ==============================================
// CONFIGURACION DEL NEGOCIO
// Edita estos valores para personalizar tu bot
// ==============================================

module.exports = {
    nombreNegocio: "Galviustech",
    nombreAsistente: "Michell",

    mensajeBienvenida: (nombreCliente) =>
          `Hola${nombreCliente ? " " + nombreCliente : ""}! Soy el asistente virtual de *Michell* en *Galviustech*.\n\n` +
          `Estoy aqui para ayudarte a encontrar el modem o impresora perfecta para ti. En que te puedo ayudar hoy?`,

    mensajeDespedida:
          "Gracias por escribirnos! Si necesitas algo mas, aqui estare",

    mensajeAsesorHumano:
          "Perfecto, ya le avise a *Michell* que quieres hablar directamente. En breve te va a escribir por aqui mismo.",

    moneda: "COP",
};
