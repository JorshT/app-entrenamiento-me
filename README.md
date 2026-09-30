# Mis Entrenamientos

Aplicación web (celular y computador) para registrar tus entrenamientos y ver
resúmenes semanales, mensuales y anuales. **Sin usuario ni contraseña**: se entra
con un **enlace único que contiene un token** (`https://tu-dominio/t/<token>`).

## Qué puedes hacer

- **Registrar sesiones**: fecha, nombre/enfoque, duración, esfuerzo (RPE 1‑10),
  peso corporal y comentarios.
- **Ejercicios de cada sesión**: series con repeticiones, kilos y RIR (opcional),
  descanso en segundos y comentarios por ejercicio.
  - Al agregar un ejercicio se **precargan las series de la última vez** y se muestra
    qué hiciste en esa ocasión.
  - **Temporizador de descanso** (⏱) con vibración/sonido al terminar.
  - Borrador automático: si cierras la pestaña a mitad de una sesión nueva, se recupera.
  - "Repetir sesión" para copiar una sesión anterior.
- **Resumen** por **semana, mes o año** (con navegación a períodos anteriores):
  - Sesiones vs. meta semanal, tiempo total, series, repeticiones, volumen (kg) y RPE
    medio, comparados con el período anterior.
  - **Series por grupo muscular** (directas + indirectas que cuentan ½), como
    promedio semanal en mes/año, marcando el rango típico de 10–20 series/semana y los
    grupos que no trabajaste.
  - Gráfico de evolución (series por músculo, kg, sesiones o minutos).
  - Calendario de constancia, ejercicios más trabajados y **récords nuevos**
    (peso máximo y 1RM estimado).
  - Historial total: desde cuándo entrenas, horas totales, racha de semanas seguidas,
    sesiones por semana y evolución del peso corporal.
- **Ejercicios**: catálogo inicial de ~45 ejercicios con grupo muscular principal y
  secundarios; puedes crear, editar y archivar. Cada ejercicio tiene su historial y
  gráfico de progreso.
- **Ajustes**: nombre, meta semanal, copiar enlace, **generar un enlace nuevo**
  (invalida el anterior), respaldo e importación en JSON.

## Cómo funciona el acceso por token

- Cada "espacio" de datos tiene un token aleatorio de 32 caracteres. Quien tenga el
  enlace puede ver y editar esos datos: trátalo como una contraseña.
- El navegador recuerda el enlace: después basta con abrir la dirección raíz.
  En el celular, usa "Agregar a pantalla de inicio" para tenerla como app.
- La app envía `Referrer-Policy: no-referrer` y `noindex` para que el token no se
  filtre a otros sitios ni a buscadores. Úsala siempre bajo **HTTPS**.

## Publicarla con Supabase + Vercel (gratis)

Los datos se guardan en **Supabase** (Postgres) y la app corre en **Vercel**.

### 1. Crear la base en Supabase

1. Entra a [supabase.com](https://supabase.com), crea una cuenta y un **New project**.
   Anota la contraseña de la base de datos que elijas.
2. Cuando el proyecto esté listo, pulsa **Connect** (arriba) y copia la cadena de
   **Transaction pooler** (puerto `6543`). Se ve así:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```
   Reemplaza `[YOUR-PASSWORD]` por tu contraseña. Si tiene símbolos como `@`, `#` o `/`,
   escríbelos codificados (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
   Usa el *pooler* y no la conexión directa: Vercel no soporta la conexión directa (IPv6).

No necesitas crear tablas: la app las crea sola la primera vez (el esquema está en
`supabase/schema.sql`, por si prefieres pegarlo en el *SQL Editor*). Las tablas quedan
con RLS activado, así que la API pública de Supabase no puede leerlas; solo tu servidor.

### 2. Generar tu token

Es la "llave" de tu enlace. Genera uno largo y aleatorio, por ejemplo:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

(o cualquier texto aleatorio de 32+ letras y números).

### 3. Desplegar en Vercel

1. Entra a [vercel.com](https://vercel.com) con tu cuenta de GitHub → **Add New → Project**
   → importa este repositorio.
2. En **Environment Variables** agrega:
   | Nombre         | Valor                                  |
   |----------------|----------------------------------------|
   | `DATABASE_URL` | la cadena del paso 1                   |
   | `ACCESS_TOKEN` | el token del paso 2                    |
3. Pulsa **Deploy**. No hay que configurar nada más (`vercel.json` ya lo define).

Tu enlace será:

```
https://<tu-proyecto>.vercel.app/t/<ACCESS_TOKEN>
```

Ábrelo en el celular y en el computador; cada navegador lo recordará.

### Sobre el plan gratuito

- **Supabase** pausa los proyectos gratuitos tras ~7 días sin actividad. Para evitarlo,
  `vercel.json` programa un *cron* diario que hace una consulta mínima (`/api/health`).
  Si aun así se pausara, reactívalo desde el panel de Supabase (no se pierden datos).
- 500 MB de base de datos alcanzan para muchos años de entrenamientos.
- Aun así, descarga un respaldo de vez en cuando desde **Ajustes → Descargar respaldo**.

### Cambiar el enlace

**Ajustes → Generar enlace nuevo** crea un token nuevo e invalida el anterior (en
todos tus dispositivos). `ACCESS_TOKEN` solo se usa para crear tu espacio la primera
vez, cuando la base está vacía, así que el token viejo no vuelve a funcionar aunque
siga en la variable.

## Ejecutar localmente

Requiere Node.js 20.12 o superior.

```bash
npm install
npm start
```

Sin `DATABASE_URL`, la app usa un Postgres embebido (PGlite) guardado en `./data`, sin
instalar nada. En el primer arranque se crea un espacio y se imprime su enlace:

```
  Se creó tu espacio de entrenamiento. Guarda este enlace (es tu "llave"):
  http://localhost:3000/t/Xq3...
```

Para trabajar contra Supabase desde tu computador, copia `.env.example` como `.env` y
completa `DATABASE_URL` (y `ACCESS_TOKEN` si quieres).

Otros comandos:

```bash
npm run new-link -- "Nombre"   # crea otro espacio con su propio enlace (usa DATABASE_URL si existe)
npm run new-link -- --list     # muestra los enlaces existentes
npm test                       # pruebas (PGlite; o un Postgres real con TEST_DATABASE_URL)
```

### Variables de entorno

| Variable       | Descripción                                                         |
|----------------|---------------------------------------------------------------------|
| `DATABASE_URL` | Cadena de conexión de Postgres/Supabase. Sin ella se usa PGlite.    |
| `ACCESS_TOKEN` | Token de tu espacio (mín. 16 caracteres). Se usa para crearlo si la base está vacía. |
| `PORT`         | Puerto HTTP local (por defecto `3000`).                             |
| `DATA_DIR`     | Carpeta de PGlite cuando no hay `DATABASE_URL` (por defecto `./data/pglite`). |
| `BASE_URL`     | URL pública, solo para imprimir los enlaces correctamente.          |

También hay un `Dockerfile` por si prefieres otro hosting (VPS, Railway, Fly.io).

## Estructura

```
api/index.js         función serverless de Vercel (todas las rutas /api)
vercel.json          configuración de Vercel (estáticos, rutas, cabeceras, cron)
server.js            servidor local / VPS, creación del primer enlace
src/app.js           API REST (/api/s/:token/...)
src/stats.js         cálculo de resúmenes y récords
src/db.js            conexión a Postgres (Supabase) o PGlite
supabase/schema.sql  esquema de la base de datos
src/catalog.js       grupos musculares y ejercicios iniciales
public/              frontend (HTML/CSS/JS sin compilación) + Chart.js
test/                pruebas con node:test
```
