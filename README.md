# Mi Gente · avisos

Las notificaciones de [Mi Gente](https://mi-gente-quedadas.web.app). Cada 5 minutos, un Cloudflare Worker
(`worker.mjs`, con el cron de `wrangler.toml`) lee la base de datos de la app (planes, chat, toques y la granja de
cabritas) y envía avisos Web Push a los dispositivos donde cada persona los ha activado. La lógica está en `core.mjs`
y el cifrado de Web Push en `webpush.mjs` (solo WebCrypto, sin dependencias), así que lo mismo funciona desde la línea
de comandos (`send.mjs`).

- Qué se avisa: plan nuevo, hora fijada, plan aplazado o con fechas cambiadas, recordatorio de respuesta, chat,
  toques; y de la granja, regalo recibido, vuelta de excursión, hambre o tristeza, caja sin abrir, racha en peligro
  (a partir de las 20:00) y eventos (cuando empiezan y su último día).
  Y a los admins, un informe de «Reportar un fallo» nuevo (el de las últimas 24 horas que sigue abierto; no a quien lo mandó).
- Nada entre las 23:00 y las 9:00 (hora de Madrid): se guardan para la mañana, y si son muchos llegan en uno.
- Lo ya avisado se guarda en `config/push-state`, así que no se repite nada.
- Las claves: `VAPID_PUBLIC` está en `wrangler.toml` (y en la app); `VAPID_PRIVATE` es un secreto del Worker
  (`wrangler secret put VAPID_PRIVATE`) y del repositorio (para las pruebas a mano).

## Por qué un Worker y no GitHub Actions

Empezó como un horario de GitHub Actions cada 10 minutos, pero GitHub lanza los horarios cuando puede: el primer
día se disparó dos veces en 14 horas. Mantenerlo vivo encadenando ejecuciones funcionaba, pero usar Actions para
tener un servicio encendido todo el día va contra sus condiciones. El cron de Cloudflare se dispara a su hora.

## Probar

- `npm test`: el cifrado contra la implementación de referencia (la de la librería `web-push`) y la firma VAPID.
- `npm run dev`, y luego `curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"`: una ronda del Worker en
  local. Con un `.dev.vars` (no se sube) que tenga `VAPID_PRIVATE`, `PROJECTS`, y para el emulador local
  `FIRESTORE_BASE` e `IGNORE_QUIET=1`.
- Aviso de prueba a una persona: Actions → Avisos → Run workflow → `test_to` = nombre.
