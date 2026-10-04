# Mi Gente · avisos

Las notificaciones de [Mi Gente](https://mi-gente-quedadas.web.app). Cada 5 minutos, un Cloudflare Worker
(`worker.mjs`, con el cron de `wrangler.toml`) lee la base de datos de la app (planes, chat, toques y la granja de
cabritas) y envía avisos Web Push a los dispositivos donde cada persona los ha activado. La lógica está en `core.mjs`
y el cifrado de Web Push en `webpush.mjs` (solo WebCrypto, sin dependencias), así que lo mismo funciona desde la línea
de comandos (`send.mjs`).

- Qué se avisa: plan nuevo, hora fijada, plan aplazado o con fechas cambiadas, recordatorio de respuesta, chat,
  toques; y de la granja, regalo recibido, vuelta de excursión, hambre o tristeza, energía a tope otra vez, caja sin abrir, racha en peligro
  (a partir de las 20:00) y eventos (cuando empiezan y su último día: los de `EVENT_SCHEDULE` en `core.mjs`, que copia el calendario de la app, y `config/farm-event` solo como anulación a mano, que manda mientras está activa). Y, solo en producción, cuando la app se
  actualiza: cada ronda lee `/version.json` de la web, y si la versión cambia respecto a la guardada
  (`appVersion` en `config/push-state`) todos los que tienen avisos reciben uno, «Mi Gente se ha actualizado», que abre
  `/?novedades`. La primera vez solo guarda la versión; si falla la lectura no pasa nada.
  Y a los admins, un informe de «Reportar un fallo» nuevo (el de las últimas 24 horas que sigue abierto; no a quien lo mandó).
- **Planes fijados: mañana, en dos horas y al empezar.** Solo para participantes confirmados a la hora fijada,
  como el contador del plan: «Voy» sin horas o con toda la franja marcada, y selecciones del sistema antiguo que
  cubran esa franja. Nunca «Quizá», pendientes, «No puedo», personas no invitadas ni planes sin fijar o archivados.
  Siguen el interruptor «Recordatorios de planes». Son independientes de Discord, incluido `discordOff` y
  `discordRemindersSent`: no cambian ningún aviso ni marcador de Discord. Se deduplican por plan, franja,
  tipo y persona en `config/push-state`; una cola se revalida antes de enviar y caduca (6 h / 45 min / 15 min).
  El TTL del servicio push también termina al caducar, para no entregar «Empieza ahora» horas después.
- Nada entre las 23:00 y las 9:00 (hora de Madrid): se guardan para la mañana, y si son muchos llegan en uno.
- Lo ya avisado se guarda en `config/push-state`, así que no se repite nada.
- Las claves: `VAPID_PUBLIC` está en `wrangler.toml` (y en la app); `VAPID_PRIVATE` es un secreto del Worker
  (`wrangler secret put VAPID_PRIVATE`) y del repositorio (para las pruebas a mano).

## Por qué un Worker y no GitHub Actions

Empezó como un horario de GitHub Actions cada 10 minutos, pero GitHub lanza los horarios cuando puede: el primer
día se disparó dos veces en 14 horas. Mantenerlo vivo encadenando ejecuciones funcionaba, pero usar Actions para
tener un servicio encendido todo el día va contra sus condiciones. El cron de Cloudflare se dispara a su hora.

## Lecturas de Firestore

Firestore cobra una lectura por documento devuelto (y una por consulta que no encuentra nada o por documento
nombrado que no existe), y el plan gratuito se para en 50.000 al día. Una ronda no lista nunca una colección: pide
solo lo que usa. Seis documentos de `config` con un `batchGet` (`users`, `roles`, `preferences`, `push-state`,
`push-test`, `farm-event`), `push-subs` y `push-prefs` en otro; consultas con un filtro de un solo campo (no piden
índice compuesto) para las cabritas (`owner` presente, solo si la granja está encendida), los regalos
(`status == 'pending'`), los informes de fallo (`at` de las últimas 24 horas) y los toques (`presence` con `missed`,
que la app borra al verlos); y la consulta de siempre del registro de planes y del chat. Con 8 cabritas, 2 informes
nuevos y un regalo son unas 22 lecturas por ronda, más dos consultas indexadas por `locked.date` (hoy y mañana
en Madrid) que leen solo los planes fijados de esos días. No se lista la colección entera de eventos. Eran unas 93 (todo `config`, que crece con cada informe, captura,
carrera y pareja de la granja, más todo `presence`). `test/reads.test.mjs` cuenta las lecturas, y
`test/fakefs.mjs` (el Firestore de las pruebas) falla si una ronda vuelve a listar una colección entera.

## Probar

- `npm test`: el cifrado contra la implementación de referencia (la de la librería `web-push`) y la firma VAPID.
- `npm run dev`, y luego `curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"`: una ronda del Worker en
  local. Con un `.dev.vars` (no se sube) que tenga `VAPID_PRIVATE`, `PROJECTS`, y para el emulador local
  `FIRESTORE_BASE` e `IGNORE_QUIET=1`.
- «Probar avisos» (Admin de la app): un admin elige personas y la app escribe la petición en `config/push-test`
  (`{ id, to: [nombres], text, by, at }`). En la siguiente ronda (menos de 5 minutos) el Worker manda la prueba a los
  móviles de esas personas, y solo de esas, sin respetar las horas de silencio, y escribe en el mismo documento
  `results` (`{ nombre: { devices, sent, failed, expired?, error?, unknown? } }`) y `doneAt`, que la app enseña.
  Nunca guarda claves ni direcciones de suscripción: solo cuentas y el código de estado. Una suscripción caducada
  se borra, como en cualquier ronda. Una petición de hace más de 30 minutos ya no sale.
- Aviso de prueba a una persona: Actions → Avisos → Run workflow → `test_to` = nombre.
