# Chatbot de WhatsApp - Galviustech

Este es tu chatbot personalizado, conectado directamente a la Meta Cloud API.
No depende de Manychat, Chateapro ni ninguna plataforma externa - el codigo es 100% tuyo.

## Que hace?

- Saluda de forma conversacional (como un asesor, no un menu robotico)
- - Muestra tu catalogo de productos con precio y descripcion
  - - Toma pedidos paso a paso (producto, cantidad, nombre, direccion)
    - - Deriva a un humano ("hablar con Michell") cuando el cliente lo pide
     
      - ## Archivos del proyecto
     
      - - server.js - el cerebro del bot (no necesitas tocarlo para uso normal)
        - - catalog.json - tu catalogo, editalo para agregar/quitar productos
          - - config.js - nombre del negocio, mensajes de bienvenida, etc.
            - - .env.example - plantilla de tus credenciales
             
              - ## Paso 1 - Consigue tus credenciales de Meta
             
              - En tu app de Meta for Developers, seccion WhatsApp > API Setup:
             
              - 1. Token de acceso (META_TOKEN)
                2. 2. Phone Number ID (PHONE_NUMBER_ID)
                  
                   3. ## Paso 2 - Sube el proyecto a Render (gratis)
                  
                   4. 1. Crea una cuenta en render.com
                      2. 2. En Render: New + -> Web Service -> conecta este repositorio de GitHub
                         3. 3. Build Command: npm install
                            4. 4. Start Command: npm start
                               5. 5. En Environment Variables agrega META_TOKEN, PHONE_NUMBER_ID y VERIFY_TOKEN (una palabra secreta que inventes)
                                  6. 6. Dale a Deploy. Render te da una URL tipo https://galviustech-bot.onrender.com
                                    
                                     7. ## Paso 3 - Conecta el webhook en Meta
                                    
                                     8. 1. En Meta for Developers, WhatsApp > Configuration
                                        2. 2. Webhook URL: https://tu-url-de-render.onrender.com/webhook
                                           3. 3. Verify Token: la misma palabra secreta que pusiste en VERIFY_TOKEN
                                              4. 4. Suscribete al campo messages
                                                
                                                 5. Listo! Ya puedes escribirle a tu numero de WhatsApp Business y el bot va a responder.
                                                
                                                 6. ## Como editar tu catalogo
                                                
                                                 7. Abre catalog.json y agrega productos con este formato:
                                                
                                                 8. ```
                                                    {
                                                      "id": "nombre-corto-sin-espacios",
                                                      "nombre": "Nombre del producto",
                                                      "precio": 100000,
                                                      "color": "Color",
                                                      "descripcion": "Descripcion breve del producto"
                                                    }
                                                    ```

                                                    Cada vez que edites este archivo, Render actualiza el bot automaticamente.
                                                    
