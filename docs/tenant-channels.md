# Conexiones por tenant

Cada workspace de Twenty es un tenant. Las credenciales, canales y atribuciones viven en ese workspace y no se comparten con otro.

`rayfranc/twenty-multitenant` no es este código: es solo el Dockerfile y el patch de aprovisionamiento sobre v2.52.0. El trabajo de conexiones va en este fork, rama `tenant-channels`.

## Qué ya trae Twenty

- Gmail y Google Calendar, por cuenta conectada del workspace (`MESSAGING_PROVIDER_GMAIL_ENABLED`, `CALENDAR_PROVIDER_GOOGLE_ENABLED`).
- Cuentas conectadas y `Message` / `MessageThread`.
- Apps pueden crear message channels (WhatsApp, SMS, etc.) sin meter cada proveedor en el core. Ver la doc de Messaging Channels.

## Qué hay que construir

Una conexión es OAuth o API key del negocio del tenant, cifrada, con `workspaceId`, `provider`, `externalAccountId`, scopes y estado.

| Proveedor | Uso | Dónde entra |
| --- | --- | --- |
| Meta | WhatsApp Cloud API, Messenger, Instagram, Ads | Una conexión de negocio Meta. Un message channel por número o página. Ads aparte, misma conexión si el scope lo permite. |
| Google | Gmail ya nativo. Ads nuevo. | No reimplementar Gmail. Añadir Google Ads OAuth y campañas. |
| Telefonía | Llamadas y SMS | Interfaz de proveedor. Primer adaptador: Twilio. Otro proveedor se enchufa igual. |

## Atribución

Al crear un lead se guardan `gclid`, `fbclid` y `utm_*`.

- Primer toque y último toque en la persona.
- Un registro `AttributionTouch`: proveedor, campaña, anuncio, click id, fecha.
- Mensajes y llamadas apuntan a la misma persona, así una oportunidad se puede unir a la campaña que la originó.

Los webhooks de Meta y Google Ads identifican al tenant por el id de la cuenta externa, no por un secreto compartido entre workspaces.

## Orden

1. Modelo de conexión por workspace y cifrado de tokens.
2. Meta: WhatsApp de entrada y salida en el inbox.
3. Telefonía: SMS y registro de llamada vía Twilio.
4. Ads: Google Ads y Meta Ads, solo lectura de campañas más el click id en el lead.
5. Gmail se deja en el conector nativo. No se duplica.
