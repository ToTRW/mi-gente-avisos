# Mi Gente · avisos

Las notificaciones de [Mi Gente](https://mi-gente-quedadas.web.app): cada 10 minutos, GitHub Actions ejecuta
`send.mjs`, que lee la base de datos de la app (planes, chat, toques y la granja de cabritas) y envía avisos Web
Push a los dispositivos donde cada persona los ha activado.

- Qué se avisa: plan nuevo, hora fijada, plan aplazado o con fechas cambiadas, recordatorio de respuesta, chat,
  toques; y de la granja, regalo recibido, vuelta de excursión, hambre o tristeza y caja sin abrir.
- Nada entre las 23:00 y las 9:00 (hora de Madrid): se guardan para la mañana, y si son muchos llegan en uno.
- Lo ya avisado se guarda en `config/push-state`, así que no se repite nada.
- Las claves: `VAPID_PUBLIC` y `VAPID_PRIVATE` son secretos del repositorio. La pública también está en la app.

Probar sin enviar nada: `DRY_RUN=1 PROJECT=mi-gente-preprod node send.mjs`.
