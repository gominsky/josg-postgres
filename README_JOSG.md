# 🎼 JOSG - Gestión de Escuela de Música

**JOSG** (Gestión de Organización para Sistema de Guardias) es una aplicación web construida con Node.js y PostgreSQL, orientada a la administración de una escuela de música. Ofrece funcionalidades para gestionar usuarios, profesores, alumnos, instrumentos, cuotas, eventos, firmas de asistencia, guardias y más.

---

## 🧱 Tecnologías principales

- **Backend**: Node.js + Express
- **Base de Datos**: PostgreSQL
- **ORM**: Consultas SQL nativas con `pg`
- **Vistas**: EJS + Express Layouts
- **Autenticación**: Sesiones (`express-session`)
- **Control de acceso**: Middleware por rol (`admin`, `docente`, `usuario`)
- **Carga de archivos**: `multer` (para fotos y documentos)

---

## 🗃️ Estructura general

- `routes/`: Contiene todas las rutas del sistema agrupadas por dominio funcional.
- `middleware/`: Lógica de autenticación y autorización.
- `views/`: Plantillas EJS para todas las páginas.
- `database/db.js`: Configuración y acceso a la base de datos PostgreSQL.
- `public/`: Archivos estáticos (CSS, JS, imágenes).
- `uploads/`: Archivos subidos por los usuarios (fotos de profesores, etc.).

---

## 🧩 Funcionalidades destacadas

- Gestión de alumnos, profesores y usuarios del sistema.
- Control de pagos y cuotas mensuales.
- Registro de asistencia mediante escaneo de QR.
- Asignación automática de guardias con lógica por experiencia.
- Generación de recibos PDF.
- Roles y permisos con autenticación basada en sesiones.
- Buscadores por filtros dinámicos y formularios reutilizables.

---
# 📘 JOSG – Backend Documentación (Express + PostgreSQL)

Este proyecto es un sistema de gestión académica musical, desarrollado en Node.js con Express y base de datos PostgreSQL. Soporta la gestión de alumnos, profesores, instrumentos, eventos, cuotas, pagos, firmas, informes y control de guardias.

---

## 📦 Estructura general

- `routes/`: Módulos de rutas de Express, cada uno enfocado en una entidad del sistema.
- `database/db.js`: Conexión central a PostgreSQL.
- `middleware/`: Middleware para autenticación y autorización.
- `views/`: Plantillas EJS.
- `uploads/`: Carpeta donde se almacenan imágenes subidas.
- `public/`: Archivos estáticos (CSS, JS, etc.).
- `app.js`: Inicializador principal del servidor.

---

## ✅ Compatibilidad con PostgreSQL

✔ Todas las rutas utilizan parámetros posicionales (`$1`, `$2`, ...) y sentencias compatibles con PostgreSQL.

✔ No hay rastros de SQLite en ninguna ruta.

---

# 📄 Módulos de rutas

## `routes/profesores.js` – Gestión de docentes

Este módulo administra las operaciones CRUD para profesores, incluyendo asociaciones con instrumentos y grupos. También permite subir fotos, filtrar por estado y renderizar vistas detalladas o formularios dinámicos.

### 📌 Funcionalidades

- Listado, creación, edición, detalle y eliminación de profesores.
- Asignación de instrumentos y grupos.
- Validación de email único.
- Subida de fotos con Multer.

---

## `routes/alumnos.js` – Gestión de alumnos

- Alta, edición, eliminación y visualización de alumnos.
- Asociación con instrumentos y grupos.
- Muestra historial de pagos y cuotas pendientes.
- Permite firma de asistencia (integración con QR y tokens).

---

## `routes/pagos.js` – Gestión de pagos

- Registro de pagos manuales.
- Aplicación automática del importe a cuotas pendientes.
- Generación de recibos PDF.
- Visualización detallada de pagos y estado de cuotas del alumno.

---

## `routes/grupos.js` – CRUD de grupos

- Alta, listado, edición y eliminación de grupos.
- Búsqueda dinámica por nombre o descripción.

---

## `routes/instrumentos.js` – CRUD de instrumentos

- Alta, edición, eliminación y listado.
- Familiares predefinidas (`Cuerda`, `Percusión`, etc.).

---

## `routes/eventos.js` – Eventos y clases

- Crea eventos con fecha, grupo, tipo.
- Permite activar tokens QR para firmar asistencia.

---

## `routes/firmas.js` – Firma de asistencia por alumnos

- Registro con credenciales y token QR.
- Prevención de doble firma por evento.
- Asistencia ligada a ubicación, fecha y hora.

---

## `routes/guardias.js` – Gestión de guardias

- Muestra guardias asignadas por fecha.
- Genera parejas automáticamente (novato + veterano).
- Considera disponibilidad y carga actual.
- Actualiza contadores por alumno.

---

## `routes/usuarios.js` – Administración de usuarios

- CRUD completo de usuarios.
- Sincronización con tabla `profesores` si es tipo docente.
- Control de roles (`admin`, `docente`).

---

## `routes/tipos_cuotas.js` – Tipos de cuota

- Módulo simple para mantener tipos de cuotas (mensualidades, etc.).
- Compatible con PostgreSQL.
- CRUD básico.

---

## `routes/control_firmas.js` – Control de firmas

- Muestra el estado de firmas por evento.
- Vistas personalizadas de asistencia.

---

## `middleware/auth.js` – Autenticación y autorización

- `isAuthenticated`: Verifica sesión iniciada.
- `isAdmin`: Acceso solo para administradores.
- `isDocente`: Acceso para docentes y admins.

---

## `app.js` – Inicialización del servidor

- Configura Express, EJS, sesiones, layouts y middlewares.
- Monta todas las rutas.
- Define funciones globales (`formatDate`) para vistas.
- Servidor escucha en puerto `3001`.

---

## 📂 Base de datos

- 100% PostgreSQL.
- Tablas: `alumnos`, `profesores`, `instrumentos`, `grupos`, `usuarios`, `eventos`, `asistencias`, `guardias`, `cuotas`, `pagos`, `tipos_cuota`, `cuotas_alumno`, `pago_cuota_alumno`.

---

## 🚀 Cómo iniciar

```bash
npm install
createdb josg
psql josg < schema_josg.sql
node app.js
```

---

## 🧪 Requisitos

- Node.js 18+
- PostgreSQL 14+
- Librerías: `express`, `ejs`, `pdfkit`, `multer`, `bcrypt`, `dayjs`, etc.

---


---

## 🗄️ Esquema SQL del sistema

```sql

-- ============================
-- Esquema básico para sistema JOSG
-- ============================

-- Tabla usuarios
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  apellidos VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  rol VARCHAR(20) NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla profesores sincronizada desde usuarios
CREATE TABLE profesores (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100),
  apellidos VARCHAR(100),
  email VARCHAR(150) UNIQUE
);

-- Tabla alumnos
CREATE TABLE alumnos (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100),
  apellidos VARCHAR(100),
  email VARCHAR(150) UNIQUE,
  dni VARCHAR(50),
  password VARCHAR(255),
  registrado BOOLEAN DEFAULT FALSE,
  foto VARCHAR(255),
  activo BOOLEAN DEFAULT TRUE,
  fecha_matriculacion DATE,
  fecha_baja DATE,
  guardias_actual INTEGER DEFAULT 0
);

-- Tabla grupos
CREATE TABLE grupos (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) UNIQUE NOT NULL,
  descripcion TEXT
);

-- Tabla instrumentos
CREATE TABLE instrumentos (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) UNIQUE NOT NULL,
  familia VARCHAR(50)
);

-- Relaciones muchos-a-muchos
CREATE TABLE alumno_grupo (
  alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE CASCADE,
  PRIMARY KEY(alumno_id, grupo_id)
);

CREATE TABLE profesor_instrumento (
  profesor_id INTEGER REFERENCES profesores(id),
  instrumento_id INTEGER REFERENCES instrumentos(id),
  PRIMARY KEY(profesor_id, instrumento_id)
);

CREATE TABLE profesor_grupo (
  profesor_id INTEGER REFERENCES profesores(id),
  grupo_id INTEGER REFERENCES grupos(id),
  PRIMARY KEY(profesor_id, grupo_id)
);

CREATE TABLE alumno_instrumento (
  alumno_id INTEGER REFERENCES alumnos(id),
  instrumento_id INTEGER REFERENCES instrumentos(id),
  PRIMARY KEY(alumno_id, instrumento_id)
);

-- Tipos de cuota y cuotas de alumnos
CREATE TABLE tipos_cuota (
  id SERIAL PRIMARY KEY,
  tipo VARCHAR(100) UNIQUE NOT NULL
);

CREATE TABLE cuotas (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  descripcion TEXT,
  precio NUMERIC(10,2) NOT NULL,
  tipo_id INTEGER REFERENCES tipos_cuota(id)
);

CREATE TABLE cuotas_alumno (
  id SERIAL PRIMARY KEY,
  alumno_id INTEGER REFERENCES alumnos(id),
  cuota_id INTEGER REFERENCES cuotas(id),
  fecha_vencimiento DATE NOT NULL,
  pagado BOOLEAN DEFAULT FALSE
);

CREATE TABLE pago_cuota_alumno (
  id SERIAL PRIMARY KEY,
  pago_id INTEGER REFERENCES pagos(id),
  cuota_alumno_id INTEGER REFERENCES cuotas_alumno(id),
  importe_aplicado NUMERIC(10,2) NOT NULL
);

-- Pagos
CREATE TABLE pagos (
  id SERIAL PRIMARY KEY,
  alumno_id INTEGER REFERENCES alumnos(id),
  importe NUMERIC(10,2) NOT NULL,
  fecha_pago DATE NOT NULL,
  medio_pago VARCHAR(50),
  referencia VARCHAR(100),
  observaciones TEXT
);

-- Informes y resultados
CREATE TABLE informes (
  id SERIAL PRIMARY KEY,
  informe VARCHAR(200),
  grupo_id INTEGER REFERENCES grupos(id),
  instrumento_id INTEGER REFERENCES instrumentos(id),
  fecha DATE
);

CREATE TABLE informe_campos (
  id SERIAL PRIMARY KEY,
  informe_id INTEGER REFERENCES informes(id),
  nombre VARCHAR(100),
  tipo VARCHAR(50),
  obligatorio BOOLEAN
);

CREATE TABLE informe_resultados (
  id SERIAL PRIMARY KEY,
  informe_id INTEGER REFERENCES informes(id),
  alumno_id INTEGER REFERENCES alumnos(id),
  campo_id INTEGER REFERENCES informe_campos(id),
  valor TEXT
);

-- Eventos y asistencias
CREATE TABLE eventos (
  id SERIAL PRIMARY KEY,
  titulo VARCHAR(200),
  descripcion TEXT,
  fecha_inicio TIMESTAMP,
  fecha_fin TIMESTAMP,
  grupo_id INTEGER REFERENCES grupos(id),
  activo BOOLEAN DEFAULT TRUE,
  hora_inicio VARCHAR(10),
  hora_fin VARCHAR(10),
  token VARCHAR(20)
);

CREATE TABLE asistencias (
  id SERIAL PRIMARY KEY,
  alumno_id INTEGER REFERENCES alumnos(id),
  evento_id INTEGER REFERENCES eventos(id) ON DELETE CASCADE,
  fecha DATE,
  hora TIME,
  tipo VARCHAR(20),
  observaciones TEXT,
  ubicacion TEXT
);

-- Guardias
CREATE TABLE guardias (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER REFERENCES eventos(id),
  fecha DATE,
  alumno_id_1 INTEGER REFERENCES alumnos(id),
  alumno_id_2 INTEGER REFERENCES alumnos(id),
  curso VARCHAR(20),
  notas TEXT
);

```


## 🚀 Instalación y Puesta en Marcha

1. Clona el repositorio:
   ```bash
   git clone https://github.com/usuario/josg.git
   cd josg
   ```

2. Instala dependencias:
   ```bash
   npm install
   ```

3. Crea un archivo `.env` con el siguiente contenido:
   ```
   SESSION_SECRET=tu_clave_secreta
   DATABASE_URL=postgresql://usuario:password@localhost:5432/josg
   ```

4. Ejecuta el servidor:
   ```bash
   node app.js
   ```

5. Accede desde tu navegador a:
   ```
   http://localhost:3001
   ```

> Asegúrate de tener PostgreSQL corriendo y la base de datos `josg` creada con el esquema SQL proporcionado.
