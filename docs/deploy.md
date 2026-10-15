# Deploy en un servidor con Docker

Todo corre en un solo servidor con Docker Compose: Postgres, Redis, Kafka, los seis servicios y Caddy, que sirve el front y da HTTPS automático. Cada merge a `main` con CI en verde se despliega solo.

```
Internet ──443──► Caddy ──► front (estático)
                    └─/api, /socket.io──► gateway ──► auth · business · booking · notifications · payments
                                                         │
                                          Postgres (5 bases) · Redis · Kafka   (red interna, sin puertos públicos)
```

## Lo que necesitás

| Qué | Recomendación | Costo aprox. |
| --- | --- | --- |
| Servidor | Ubuntu 24.04, **4 GB de RAM**, 2 vCPU (Hetzner CX22, DigitalOcean, Vultr…) | US$5–12/mes |
| Dominio | Cualquier registrador; un registro **A** al IP del servidor | US$10/año |
| Repositorio | GitHub (puede ser privado) | gratis |
| Email | Resend, Brevo o Mailgun (SMTP) | gratis hasta ~3.000/mes |
| Mercado Pago | Opcional: sin credenciales se usa el checkout simulado | — |

## 1. Subir el código a GitHub

```bash
git remote add origin git@github.com:<usuario>/turnos.git
git push -u origin main
```

## 2. Preparar el servidor

Con el servidor creado y el dominio apuntando a su IP, entrar por SSH como root:

```bash
curl -fsSLO https://raw.githubusercontent.com/<usuario>/turnos/main/infra/deploy/setup-server.sh
REPO=https://github.com/<usuario>/turnos.git sh setup-server.sh
```

El script instala Docker, agrega 2 GB de swap, deja abiertos solo los puertos 22, 80 y 443, crea el usuario `deploy`, clona el repo en `/opt/turnos` y programa un backup diario de Postgres. Si el repo es privado, agregá una deploy key de solo lectura en GitHub y cloná por SSH.

## 3. Configurar los secretos

```bash
cd /opt/turnos
cp infra/.env.prod.example infra/.env.prod
nano infra/.env.prod
```

Completar dominio, `POSTGRES_PASSWORD`, `JWT_SECRET`, `INTERNAL_TOKEN` (cada uno con `openssl rand -hex 32`) y el SMTP. El archivo no se versiona.

## 4. Primer arranque

```bash
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod up -d --build
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod ps
```

El primer arranque construye las imágenes (unos minutos), crea las cinco bases y cada servicio aplica sus migraciones. Caddy pide el certificado HTTPS a Let's Encrypt la primera vez que entra alguien al dominio.

Para cargar la Barbería Demo, desde cualquier máquina:

```bash
API_URL=https://turnos.tudominio.com/api/v1 node infra/seed/seed.mjs
```

## 5. Deploy automático desde GitHub

En GitHub → Settings → Secrets and variables → Actions, crear:

| Secreto | Valor |
| --- | --- |
| `DEPLOY_HOST` | IP o dominio del servidor |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | clave **privada** de un par generado para esto (`ssh-keygen -t ed25519 -f deploy_key`) |

La clave **pública** (`deploy_key.pub`) va en `/home/deploy/.ssh/authorized_keys` del servidor.

Desde ahí, cada push a `main` corre CI; si pasa, `.github/workflows/deploy.yml` construye las imágenes, las publica en GitHub Container Registry y actualiza el servidor (`docker compose pull` + `up -d`). También se puede lanzar a mano desde la pestaña Actions.

## Operación

```bash
cd /opt/turnos
C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod"

$C ps                          # estado y health de cada contenedor
$C logs -f gateway booking     # logs JSON; filtrar por requestId para seguir una request
$C restart notifications       # reiniciar un servicio
turnos-backup                  # backup manual (los automáticos quedan en /var/backups/turnos)
```

Restaurar un backup:

```bash
gunzip -c /var/backups/turnos/turnos-AAAAMMDD-HHMM.sql.gz | docker exec -i turnos-prod-postgres-1 psql -U turnos -d postgres
```

## Notas

- **Memoria:** con 4 GB alcanza. Kafka está limitado a 384 MB de heap y hay 2 GB de swap por las dudas.
- **Mercado Pago real:** completar `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET`, y en el panel de MP configurar el webhook a `https://<dominio>/api/v1/webhooks/mercadopago`.
- **Bull Board y Swagger** no se exponen en producción: Bull Board está apagado y los `/docs` de cada servicio quedan en la red interna.
- **Escalar:** esta configuración es de una sola máquina. Los servicios no guardan estado propio (el estado vive en Postgres, Redis y Kafka), así que se pueden pasar a Kubernetes o a varias máquinas sin cambiar el código.
