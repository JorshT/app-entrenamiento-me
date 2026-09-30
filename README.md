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

## Ejecutar localmente

Requiere Node.js 20 o superior.

```bash
npm install
npm start
```

En el primer arranque se crea un espacio y se imprime su enlace en la consola:

```
  Se creó tu espacio de entrenamiento. Guarda este enlace (es tu "llave"):
  http://localhost:3000/t/Xq3...
```

Otros comandos:

```bash
npm run new-link -- "Nombre"   # crea otro espacio con su propio enlace
npm run new-link -- --list     # muestra los enlaces existentes
npm test                       # pruebas de la API
```

### Variables de entorno

| Variable       | Descripción                                                       |
|----------------|-------------------------------------------------------------------|
| `PORT`         | Puerto HTTP (por defecto `3000`).                                 |
| `DATA_DIR`     | Carpeta de la base SQLite (por defecto `./data`).                 |
| `ACCESS_TOKEN` | Fija tu token (mín. 16 caracteres). Útil en hostings sin consola. |
| `BASE_URL`     | URL pública, solo para imprimir los enlaces correctamente.        |

## Publicarla en internet

Los datos se guardan en un archivo SQLite, así que el hosting debe tener
**disco persistente**:

- **Render**: el repo incluye `render.yaml` (plan con disco). Tras desplegar, tu
  enlace es `https://<tu-app>.onrender.com/t/<ACCESS_TOKEN>` (el valor está en
  *Environment*).
- **Railway / Fly.io / VPS**: usa el `Dockerfile` y monta un volumen en `/data`.
  Define `ACCESS_TOKEN` con un valor largo y aleatorio, por ejemplo:
  `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

Haz respaldos de vez en cuando desde **Ajustes → Descargar respaldo**.

## Estructura

```
server.js            arranque, creación del primer enlace
src/app.js           API REST (/api/s/:token/...) y servidor de la SPA
src/stats.js         cálculo de resúmenes y récords
src/db.js            esquema SQLite
src/catalog.js       grupos musculares y ejercicios iniciales
public/              frontend (HTML/CSS/JS sin compilación) + Chart.js
test/                pruebas con node:test
```
