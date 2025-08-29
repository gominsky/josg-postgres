// database/init.js
const db = require('./db');
const bcrypt = require('bcrypt');

const saltRounds = 12;

// Helper: ejecutar SQL y mostrar el snippet exacto si hay error de sintaxis
async function run(sql, label = '') {
  try {
    return await db.query(sql);
  } catch (e) {
    console.error(`\n❌ SQL error${label ? ' in '+label : ''}:`, e.message);
    if (e.position) {
      const pos = parseInt(e.position, 10);
      if (!Number.isNaN(pos)) {
        const from = Math.max(0, pos - 100);
        const to = Math.min(sql.length, pos + 100);
        const snippet = sql.slice(from, to);
        console.error(`↳ at position ${pos}. Around here:\n---\n${snippet}\n---`);
      }
    }
    throw e;
  }
}

/**
 * Inicializa la base de datos.
 * @param {Object} opts
 * @param {boolean} [opts.reset=false] - Si true, hace DROP de todo antes de crear (sin usar .env).
 */
async function init({ reset = false } = {}) {
  try {
    // Log de conexión (útil para no equivocarse de DB)
    try {
      console.log(`[db] host=${process.env.PGHOST} db=${process.env.PGDATABASE} user=${process.env.PGUSER}`);
    } catch {}

    // ============================
    // 1) RESET (DROP) con COMMIT propio (sólo si reset === true)
    // ============================
    if (reset) {
      console.log('⚠️  RESET activo → DROP SCHEMA public CASCADE');
      await run('BEGIN', 'drop-begin');
      await run(`
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO PUBLIC;
      `, 'drop-schema');
      await run('COMMIT', 'drop-commit');
    } else {
      console.log('RESET desactivado: modo migración (no se borra nada).');
    }

    // Extensiones (tras recrear el schema si hubo reset)
    await run(`CREATE EXTENSION IF NOT EXISTS citext;`, 'extensions');

    // ============================
    // 2) Transacción principal
    // ============================
    await run('BEGIN', 'tx-begin');

    // Funciones comunes
    await run(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
    `, 'fn:set_updated_at');

    // ============================
    // 3) TABLAS BASE
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre           TEXT        NOT NULL,
        apellidos        TEXT        NOT NULL,
        email            CITEXT      NOT NULL UNIQUE,
        password_hash    TEXT        NOT NULL,
        rol              TEXT        NOT NULL DEFAULT 'usuario'
                          CHECK (rol IN ('admin','docente','usuario')),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alumnos (
        id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre               TEXT,
        apellidos            TEXT,
        tutor                TEXT,
        direccion            TEXT,
        codigo_postal        INTEGER,
        municipio            TEXT,
        provincia            TEXT,
        telefono             TEXT,
        email                CITEXT,
        fecha_nacimiento     DATE,
        DNI                  TEXT,
        centro               TEXT,
        profesor_centro      TEXT,
        repertorio_id        INTEGER,
        foto                 TEXT,
        activo               BOOLEAN     NOT NULL DEFAULT TRUE,
        registrado           BOOLEAN     NOT NULL DEFAULT FALSE,
        guardias_actual      INTEGER     NOT NULL DEFAULT 0,
        guardias_hist        INTEGER     NOT NULL DEFAULT 0,
        fecha_matriculacion  DATE,
        fecha_baja           DATE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_alumnos_dni UNIQUE (DNI)
          DEFERRABLE INITIALLY IMMEDIATE
      );

      CREATE TABLE IF NOT EXISTS profesores (
        id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre             TEXT NOT NULL,
        apellidos          TEXT NOT NULL,
        email              CITEXT,
        fecha_nacimiento   DATE,
        telefono           TEXT,
        direccion          TEXT,
        especialidad       TEXT,
        foto               TEXT,
        activo             BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS instrumentos (
        id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre     TEXT NOT NULL,
        familia    TEXT NOT NULL CHECK (familia IN ('Cuerda','Percusión','Viento madera','Viento metal','Otra')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_instrumentos_nombre UNIQUE (nombre)
      );

      CREATE TABLE IF NOT EXISTS grupos (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre      TEXT NOT NULL,
        descripcion TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `, 'tables:base');

    // Para esquemas legacy (si no venías de RESET)
    await run(`
      ALTER TABLE IF EXISTS usuarios       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS alumnos        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS profesores     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS instrumentos   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS grupos         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS eventos        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS asistencias    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS informes       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS proveedores    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE IF EXISTS facturas_prov  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `, 'alter:add-updated_at-cols');

    // Dedup grupos por nombre (case-insensitive) y unique index por expresión
    await run(`
      WITH d AS (
        SELECT LOWER(nombre) e, MIN(id) keep_id
        FROM grupos
        GROUP BY LOWER(nombre)
        HAVING COUNT(*) > 1
      ), victims AS (
        SELECT g.id
        FROM grupos g
        JOIN d ON LOWER(g.nombre) = d.e
        WHERE g.id <> d.keep_id
      )
      UPDATE grupos
         SET nombre = nombre || ' (dup ' || id::text || ')'
       WHERE id IN (SELECT id FROM victims);
    `, 'dedupe:grupos-nombre');

    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_grupos_nombre_ci ON grupos (LOWER(nombre));
    `, 'idx:grupos-unique-ci');

    // ============================
    // 4) RELACIONES (JOIN TABLES) + Índices
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS alumno_instrumento (
        alumno_id      INTEGER NOT NULL REFERENCES alumnos(id)      ON DELETE CASCADE,
        instrumento_id INTEGER NOT NULL REFERENCES instrumentos(id) ON DELETE CASCADE,
        PRIMARY KEY (alumno_id, instrumento_id)
      );
      CREATE TABLE IF NOT EXISTS profesor_instrumento (
        profesor_id     INTEGER NOT NULL REFERENCES profesores(id)  ON DELETE CASCADE,
        instrumento_id  INTEGER NOT NULL REFERENCES instrumentos(id)ON DELETE CASCADE,
        PRIMARY KEY (profesor_id, instrumento_id)
      );
      CREATE TABLE IF NOT EXISTS alumno_grupo (
        alumno_id  INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        grupo_id   INTEGER NOT NULL REFERENCES grupos(id)  ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (alumno_id, grupo_id)
      );
      CREATE TABLE IF NOT EXISTS profesor_grupo (
        profesor_id INTEGER NOT NULL REFERENCES profesores(id) ON DELETE CASCADE,
        grupo_id    INTEGER NOT NULL REFERENCES grupos(id)     ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (profesor_id, grupo_id)
      );

      CREATE INDEX IF NOT EXISTS idx_alumno_instr_alumno   ON alumno_instrumento(alumno_id);
      CREATE INDEX IF NOT EXISTS idx_alumno_instr_instr    ON alumno_instrumento(instrumento_id);
      CREATE INDEX IF NOT EXISTS idx_profesor_instr_prof   ON profesor_instrumento(profesor_id);
      CREATE INDEX IF NOT EXISTS idx_profesor_instr_instr  ON profesor_instrumento(instrumento_id);
      CREATE INDEX IF NOT EXISTS idx_alumno_grupo_alumno   ON alumno_grupo(alumno_id);
      CREATE INDEX IF NOT EXISTS idx_alumno_grupo_grupo    ON alumno_grupo(grupo_id);
      CREATE INDEX IF NOT EXISTS idx_profesor_grupo_prof   ON profesor_grupo(profesor_id);
      CREATE INDEX IF NOT EXISTS idx_profesor_grupo_grupo  ON profesor_grupo(grupo_id);
    `, 'tables:joins+idx');

    // ============================
    // 5) EVENTOS / ASISTENCIAS / GUARDIAS
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS eventos (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titulo        TEXT NOT NULL,
        descripcion   TEXT,
        fecha_inicio  DATE NOT NULL,
        fecha_fin     DATE NOT NULL,
        hora_inicio   TIME,
        hora_fin      TIME,
        observaciones TEXT,
        grupo_id      INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
        token         TEXT,
        activo        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_eventos_token ON eventos(token) WHERE token IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_eventos_grupo ON eventos(grupo_id);
      CREATE INDEX IF NOT EXISTS idx_eventos_activos_grupo ON eventos(grupo_id, fecha_inicio) WHERE activo IS TRUE;

      CREATE TABLE IF NOT EXISTS asistencias (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        evento_id     INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
        alumno_id     INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        fecha         DATE,
        hora          TIME,
        ubicacion     TEXT,
        observaciones TEXT,
        tipo          TEXT NOT NULL DEFAULT 'qr',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asistencias_alumno_evento_uniq UNIQUE (alumno_id, evento_id)
      );
      CREATE INDEX IF NOT EXISTS idx_asistencias_evento      ON asistencias(evento_id);
      CREATE INDEX IF NOT EXISTS idx_asistencias_alumno      ON asistencias(alumno_id);
      CREATE INDEX IF NOT EXISTS idx_asistencias_evento_hora ON asistencias(evento_id, hora);

      CREATE TABLE IF NOT EXISTS guardias (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        evento_id   INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
        fecha       DATE NOT NULL,
        alumno_id_1 INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        alumno_id_2 INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        notas       TEXT,
        curso       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ck_guardias_distintos CHECK (alumno_id_1 <> alumno_id_2)
      );
      CREATE INDEX IF NOT EXISTS idx_guardias_evento  ON guardias(evento_id);
      CREATE INDEX IF NOT EXISTS idx_guardias_alumno1 ON guardias(alumno_id_1);
      CREATE INDEX IF NOT EXISTS idx_guardias_alumno2 ON guardias(alumno_id_2);
    `, 'tables:eventos+asistencias+guardias');

    // ============================
    // 6) INFORMES
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS informes (
        id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        informe        TEXT NOT NULL,
        grupo_id       INTEGER REFERENCES grupos(id)       ON DELETE SET NULL,
        instrumento_id INTEGER REFERENCES instrumentos(id) ON DELETE SET NULL,
        profesor_id    INTEGER REFERENCES profesores(id)   ON DELETE SET NULL,
        fecha          DATE DEFAULT CURRENT_DATE,
        public_slug    TEXT UNIQUE,
        observaciones  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_informes_grupo ON informes(grupo_id);
      CREATE INDEX IF NOT EXISTS idx_informes_instr ON informes(instrumento_id);
      CREATE INDEX IF NOT EXISTS idx_informes_prof  ON informes(profesor_id);

      CREATE TABLE IF NOT EXISTS informe_campos (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        informe_id  INTEGER NOT NULL REFERENCES informes(id) ON DELETE CASCADE,
        nombre      TEXT NOT NULL,
        tipo        TEXT NOT NULL,
        obligatorio BOOLEAN NOT NULL DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS informe_resultados (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        informe_id  INTEGER NOT NULL REFERENCES informes(id) ON DELETE CASCADE,
        alumno_id   INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
        campo_id    INTEGER NOT NULL REFERENCES informe_campos(id) ON DELETE CASCADE,
        valor       TEXT,
        fila        INTEGER
      );
    `, 'tables:informes');

    // ============================
    // 7) CUOTAS / PAGOS (ALUMNOS)
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS tipos_cuota (
        id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        tipo TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS cuotas (
        id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre       TEXT NOT NULL,
        precio       NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
        descripcion  TEXT,
        tipo_id      INTEGER NOT NULL REFERENCES tipos_cuota(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS cuotas_alumno (
        id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        alumno_id         INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
        cuota_id          INTEGER NOT NULL REFERENCES cuotas(id)   ON DELETE RESTRICT,
        pagado            BOOLEAN NOT NULL DEFAULT FALSE,
        fecha_vencimiento DATE,
        fecha_pago        DATE
      );
      CREATE INDEX IF NOT EXISTS idx_cuotas_alumno_alumno       ON cuotas_alumno(alumno_id);
      CREATE INDEX IF NOT EXISTS idx_cuotas_alumno_cuota        ON cuotas_alumno(cuota_id);
      CREATE INDEX IF NOT EXISTS idx_cuotas_alumno_pendientes   ON cuotas_alumno(alumno_id, fecha_vencimiento) WHERE pagado IS FALSE;

      CREATE TABLE IF NOT EXISTS pagos (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        alumno_id   INTEGER REFERENCES alumnos(id) ON DELETE SET NULL,
        importe     NUMERIC(12,2) NOT NULL CHECK (importe >= 0),
        fecha_pago  DATE NOT NULL,
        medio_pago  TEXT,
        referencia  TEXT,
        observaciones TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pagos_alumno ON pagos(alumno_id);

      CREATE TABLE IF NOT EXISTS pago_cuota_alumno (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        pago_id          INTEGER NOT NULL REFERENCES pagos(id)          ON DELETE CASCADE,
        cuota_alumno_id  INTEGER NOT NULL REFERENCES cuotas_alumno(id) ON DELETE CASCADE,
        importe_aplicado NUMERIC(12,2) NOT NULL CHECK (importe_aplicado >= 0),
        CONSTRAINT uq_pago_cuota UNIQUE (pago_id, cuota_alumno_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pago_cuota_pago    ON pago_cuota_alumno(pago_id);
      CREATE INDEX IF NOT EXISTS idx_pago_cuota_cuotaal ON pago_cuota_alumno(cuota_alumno_id);
    `, 'tables:cuotas+pagos');

    // ============================
    // 8) LAYOUT ESCENARIO
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS layout_posiciones (
        id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        layout_id    TEXT    NOT NULL,
        instrumento  TEXT    NOT NULL,
        atril        INT     NOT NULL,
        puesto       INT     NOT NULL,
        x            NUMERIC NOT NULL,
        y            NUMERIC NOT NULL,
        angulo       NUMERIC DEFAULT 0,
        CONSTRAINT uq_layout_pos UNIQUE (layout_id, instrumento, atril, puesto),
        CONSTRAINT ck_xy_range CHECK (x >= 0 AND x <= 1 AND y >= 0 AND y <= 1)
      );
    `, 'tables:layout');

    // ============================
    // 9) RESET DE CONTRASEÑAS
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        usuario_id   INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (usuario_id, token_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_pwresets_token ON password_resets(token_hash);
      CREATE INDEX IF NOT EXISTS idx_pwresets_exp   ON password_resets(expires_at);
    `, 'tables:password_resets');

    // ============================
    // 10) CONTABILIDAD BÁSICA
    // ============================
    await run(`
      CREATE TABLE IF NOT EXISTS categorias_gasto (
        id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre   TEXT NOT NULL,
        codigo   TEXT,
        padre_id INT REFERENCES categorias_gasto(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS cuentas (
        id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre         TEXT NOT NULL,
        tipo           TEXT NOT NULL CHECK (tipo IN ('banco','caja')),
        iban           TEXT,
        saldo_inicial  NUMERIC(12,2) DEFAULT 0,
        fecha_saldo    DATE,
        activo         BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS proveedores (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nombre        TEXT NOT NULL,
        cif           TEXT,
        email         CITEXT,
        telefono      TEXT,
        direccion     TEXT,
        municipio     TEXT,
        provincia     TEXT,
        codigo_postal TEXT,
        iban          TEXT,
        contacto      TEXT,
        notas         TEXT,
        activo        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS facturas_prov (
        id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        proveedor_id      INT NOT NULL REFERENCES proveedores(id),
        categoria_id      INT REFERENCES categorias_gasto(id),
        cuenta_id         INT REFERENCES cuentas(id),
        numero            TEXT NOT NULL,
        fecha_emision     DATE NOT NULL,
        fecha_vencimiento DATE,
        concepto          TEXT,
        base_imponible    NUMERIC(12,2) NOT NULL DEFAULT 0,
        iva_pct           NUMERIC(5,2)  NOT NULL DEFAULT 21,
        total             NUMERIC(12,2) NOT NULL,
        estado            TEXT NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('borrador','pendiente','parcial','pagada','anulada')),
        adjunto_path      TEXT,
        notas             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_proveedor   ON facturas_prov(proveedor_id);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_estado      ON facturas_prov(estado);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_vencimiento ON facturas_prov(fecha_vencimiento);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_numero      ON facturas_prov(numero);

      CREATE TABLE IF NOT EXISTS pagos_prov (
        id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        proveedor_id   INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
        cuenta_id      INTEGER REFERENCES cuentas(id),
        fecha          DATE NOT NULL DEFAULT CURRENT_DATE,
        importe_total  NUMERIC(12,2) NOT NULL CHECK (importe_total >= 0),
        metodo         TEXT NOT NULL CHECK (metodo IN ('transferencia','tarjeta','efectivo','domiciliacion','otro')),
        referencia     TEXT,
        notas          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pagos_prov_proveedor ON pagos_prov(proveedor_id);
      CREATE INDEX IF NOT EXISTS idx_pagos_prov_fecha     ON pagos_prov(fecha);

      CREATE TABLE IF NOT EXISTS pagos_prov_aplicaciones (
        id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        pago_id          INTEGER NOT NULL REFERENCES pagos_prov(id)    ON DELETE CASCADE,
        factura_id       INTEGER NOT NULL REFERENCES facturas_prov(id) ON DELETE CASCADE,
        importe_aplicado NUMERIC(12,2) NOT NULL CHECK (importe_aplicado >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_pagos_apl_factura ON pagos_prov_aplicaciones(factura_id);
      CREATE INDEX IF NOT EXISTS idx_pagos_apl_pago    ON pagos_prov_aplicaciones(pago_id);

      CREATE TABLE IF NOT EXISTS factura_adjuntos (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        factura_id    INTEGER NOT NULL REFERENCES facturas_prov(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        original_name TEXT,
        mime          TEXT,
        size_bytes    INTEGER,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_adjuntos_factura ON factura_adjuntos(factura_id);
    `, 'tables:contabilidad');

    // Triggers updated_at (sólo si no existen)
    await run(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_usuarios_updated_at')      THEN CREATE TRIGGER trg_usuarios_updated_at      BEFORE UPDATE ON usuarios      FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_alumnos_updated_at')       THEN CREATE TRIGGER trg_alumnos_updated_at       BEFORE UPDATE ON alumnos       FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profesores_updated_at')     THEN CREATE TRIGGER trg_profesores_updated_at     BEFORE UPDATE ON profesores    FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_instrumentos_updated_at')   THEN CREATE TRIGGER trg_instrumentos_updated_at   BEFORE UPDATE ON instrumentos  FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_grupos_updated_at')         THEN CREATE TRIGGER trg_grupos_updated_at         BEFORE UPDATE ON grupos        FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_eventos_updated_at')        THEN CREATE TRIGGER trg_eventos_updated_at        BEFORE UPDATE ON eventos       FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_asistencias_updated_at')    THEN CREATE TRIGGER trg_asistencias_updated_at    BEFORE UPDATE ON asistencias   FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_informes_updated_at')       THEN CREATE TRIGGER trg_informes_updated_at       BEFORE UPDATE ON informes      FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_proveedores_updated_at')    THEN CREATE TRIGGER trg_proveedores_updated_at    BEFORE UPDATE ON proveedores   FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_facturas_prov_updated_at')  THEN CREATE TRIGGER trg_facturas_prov_updated_at  BEFORE UPDATE ON facturas_prov FOR EACH ROW EXECUTE FUNCTION set_updated_at(); END IF;
      END $$;
    `, 'triggers:updated_at');

    // Trigger de control: no sobre-aplicar pagos a una factura
    await run(`
      CREATE OR REPLACE FUNCTION trg_chk_aplicaciones_factura()
      RETURNS TRIGGER AS $fn$
      DECLARE
        v_total    NUMERIC(12,2);
        v_aplicado NUMERIC(12,2);
        v_eps      NUMERIC := 0.01;
      BEGIN
        SELECT total INTO v_total FROM facturas_prov WHERE id = NEW.factura_id FOR UPDATE;
        IF v_total IS NULL THEN
          RAISE EXCEPTION 'Factura % no encontrada', NEW.factura_id USING ERRCODE = '23503';
        END IF;

        SELECT COALESCE(SUM(importe_aplicado),0) INTO v_aplicado
          FROM pagos_prov_aplicaciones
         WHERE factura_id = NEW.factura_id
           AND (TG_OP <> 'UPDATE' OR id <> COALESCE(OLD.id, -1));

        v_aplicado := v_aplicado + NEW.importe_aplicado;

        IF v_aplicado - v_total > v_eps THEN
          RAISE EXCEPTION 'Aplicaciones (%.2f) superan total (%.2f) para factura %', v_aplicado, v_total, NEW.factura_id USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $fn$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_chk_apl_ins ON pagos_prov_aplicaciones;
      DROP TRIGGER IF EXISTS trg_chk_apl_upd ON pagos_prov_aplicaciones;
      CREATE TRIGGER trg_chk_apl_ins BEFORE INSERT ON pagos_prov_aplicaciones FOR EACH ROW EXECUTE FUNCTION trg_chk_aplicaciones_factura();
      CREATE TRIGGER trg_chk_apl_upd BEFORE UPDATE ON pagos_prov_aplicaciones FOR EACH ROW EXECUTE FUNCTION trg_chk_aplicaciones_factura();
    `, 'triggers:contabilidad');

    // ============================
    // 11) VISTAS / ÍNDICES EXTRA
    // ============================
    // Dedup de emails (antes de índices únicos parciales)
    await run(`
      WITH d AS (
        SELECT LOWER(email) e, MIN(id) keep_id
        FROM alumnos
        WHERE email IS NOT NULL
        GROUP BY LOWER(email)
        HAVING COUNT(*) > 1
      ), victims AS (
        SELECT a.id
        FROM alumnos a
        JOIN d ON LOWER(a.email) = d.e
        WHERE a.id <> d.keep_id
      )
      UPDATE alumnos SET email = NULL WHERE id IN (SELECT id FROM victims);
    `, 'dedupe:alumnos-email');

    await run(`
      WITH d AS (
        SELECT LOWER(email) e, MIN(id) keep_id
        FROM profesores
        WHERE email IS NOT NULL
        GROUP BY LOWER(email)
        HAVING COUNT(*) > 1
      ), victims AS (
        SELECT p.id
        FROM profesores p
        JOIN d ON LOWER(p.email) = d.e
        WHERE p.id <> d.keep_id
      )
      UPDATE profesores SET email = NULL WHERE id IN (SELECT id FROM victims);
    `, 'dedupe:profesores-email');

    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_alumnos_email_ci    ON alumnos    (email) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_profesores_email_ci ON profesores (email) WHERE email IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_layout_pos_layout  ON layout_posiciones (layout_id);
      CREATE INDEX IF NOT EXISTS idx_layout_pos_lookup  ON layout_posiciones (layout_id, instrumento, atril, puesto);

      CREATE INDEX IF NOT EXISTS idx_informes_informe   ON informes (informe);
      CREATE INDEX IF NOT EXISTS idx_inf_campos_inf_nom ON informe_campos (informe_id, nombre);
      CREATE INDEX IF NOT EXISTS idx_inf_resultados_fk  ON informe_resultados (informe_id, campo_id, fila);

      CREATE INDEX IF NOT EXISTS idx_facturas_prov_fecha_emision      ON facturas_prov (fecha_emision);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_proveedor_estado   ON facturas_prov (proveedor_id, estado);
    `, 'idx:extras');

    // Vista normalizada “Prueba de atril”
    await run(`
      CREATE OR REPLACE VIEW pruebas_atril_norm AS
      WITH parsed AS (
        SELECT
          i.id AS informe_id,
          trim((regexp_match(i.informe, '([0-9]{2}/[0-9]{2}T[1-4])', 'i'))[1]) AS trimestre,
          NULLIF(trim(g.nombre), '')   AS grupo,
          NULLIF(trim(ins.nombre), '') AS instrumento
        FROM informes i
        LEFT JOIN grupos        g   ON g.id   = i.grupo_id
        LEFT JOIN instrumentos  ins ON ins.id = i.instrumento_id
        WHERE i.informe ~* 'Prueba[[:space:]]+de[[:space:]]+atril'
      ),
      campos AS (
        SELECT ic.informe_id, ic.id AS campo_id, ic.nombre AS campo_nombre
        FROM informe_campos ic
      ),
      res AS (
        SELECT ir.informe_id, ir.campo_id, ir.fila, trim(ir.valor) AS valor, ir.alumno_id
        FROM informe_resultados ir
      ),
      pivot AS (
        SELECT
          p.informe_id, p.trimestre, p.grupo, p.instrumento, r.fila,
          COALESCE(
            MAX(CASE WHEN c.campo_nombre ILIKE '%alumno_id%' THEN NULLIF(r.valor,'') END),
            MAX(r.alumno_id)::text
          ) AS alumno_id,
          MAX(CASE WHEN c.campo_nombre ILIKE '%puntuaci%' OR c.campo_nombre ILIKE '%score%' OR c.campo_nombre ILIKE '%punto%' THEN NULLIF(r.valor,'') END) AS puntuacion_raw,
          MAX(CASE WHEN c.campo_nombre ILIKE '%asist%'   OR c.campo_nombre ILIKE '%presenc%' OR c.campo_nombre ILIKE '%present%' THEN NULLIF(r.valor,'') END) AS asistencia_raw
        FROM parsed p
        LEFT JOIN res    r ON r.informe_id = p.informe_id
        LEFT JOIN campos c ON c.informe_id = r.informe_id AND c.campo_id = r.campo_id
        GROUP BY p.informe_id, p.trimestre, p.grupo, p.instrumento, r.fila
      )
      SELECT
        grupo,
        instrumento,
        trimestre,
        alumno_id,
        NULLIF(puntuacion_raw,'')::numeric AS puntuacion,
        CASE
          WHEN asistencia_raw ILIKE 's%' THEN TRUE
          WHEN asistencia_raw ILIKE 'y%' THEN TRUE
          WHEN asistencia_raw ~* '^(1|true|presente)$' THEN TRUE
          ELSE FALSE
        END AS asistencia
      FROM pivot
      WHERE grupo IS NOT NULL
        AND instrumento IS NOT NULL
        AND (alumno_id IS NOT NULL OR puntuacion_raw IS NOT NULL OR asistencia_raw IS NOT NULL);
    `, 'view:pruebas_atril_norm');

    // Vista de sumas/saldo de factura
    await run(`
      CREATE OR REPLACE VIEW v_factura_sumas_pagos AS
      SELECT
        f.id AS factura_id,
        COALESCE(SUM(a.importe_aplicado),0)::NUMERIC(12,2) AS pagado,
        GREATEST(f.total - COALESCE(SUM(a.importe_aplicado),0), 0)::NUMERIC(12,2) AS saldo
      FROM facturas_prov f
      LEFT JOIN pagos_prov_aplicaciones a ON a.factura_id = f.id
      GROUP BY f.id;
    `, 'view:v_factura_sumas_pagos');

    // ============================
    // 12) SEEDS (idempotentes)
    // ============================
    // Cuentas base
    await run(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM cuentas WHERE nombre = 'Banco') THEN
          INSERT INTO cuentas (nombre, tipo) VALUES ('Banco', 'banco');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM cuentas WHERE nombre = 'Caja') THEN
          INSERT INTO cuentas (nombre, tipo) VALUES ('Caja', 'caja');
        END IF;
      END $$;
    `, 'seed:cuentas');

    // Tipos de cuota
    const tiposCuota = ['Mensual', 'Puntual', 'Anual', 'Otra'];
    const resTipos = await run('SELECT COUNT(*) FROM tipos_cuota', 'seed:tipos_cuota-count');
    if (parseInt(resTipos.rows[0].count, 10) === 0) {
      for (const tipo of tiposCuota) {
        await run(`INSERT INTO tipos_cuota (tipo) VALUES ('${tipo.replace(/'/g, "''")}')`);
      }
      console.log('Tipos de cuota insertados.');
    }

    // Cuotas base
    const cuotasBase = [
      { nombre: 'Mensualidad',  precio: 50,  tipo: 'Mensual' },
      { nombre: 'Extraordinaria', precio: 100, tipo: 'Puntual' },
      { nombre: 'Matrícula',    precio: 100, tipo: 'Puntual' }
    ];
    const resCuotas = await run('SELECT COUNT(*) FROM cuotas', 'seed:cuotas-count');
    if (parseInt(resCuotas.rows[0].count, 10) === 0) {
      for (const cuota of cuotasBase) {
        const tipoId = await run(`SELECT id FROM tipos_cuota WHERE tipo = '${cuota.tipo.replace(/'/g, "''")}'`);
        if (tipoId.rows.length > 0) {
          await run(`INSERT INTO cuotas (nombre, precio, tipo_id) VALUES ('${cuota.nombre.replace(/'/g, "''")}', ${cuota.precio}, ${tipoId.rows[0].id})`);
        }
      }
      console.log('Cuotas base insertadas.');
    }

    // Instrumentos base
    const instrumentos = [
      { nombre: 'Violín',      familia: 'Cuerda' },
      { nombre: 'Viola',       familia: 'Cuerda' },
      { nombre: 'Violonchelo', familia: 'Cuerda' },
      { nombre: 'Contrabajo',  familia: 'Cuerda' },
      { nombre: 'Flauta',      familia: 'Viento madera' },
      { nombre: 'Oboe',        familia: 'Viento madera' },
      { nombre: 'Clarinete',   familia: 'Viento madera' },
      { nombre: 'Fagot',       familia: 'Viento madera' },
      { nombre: 'Trompeta',    familia: 'Viento metal' },
      { nombre: 'Trompa',      familia: 'Viento metal' },
      { nombre: 'Trombón',     familia: 'Viento metal' },
      { nombre: 'Tuba',        familia: 'Viento metal' },
      { nombre: 'Percusión',   familia: 'Percusión' },
      { nombre: 'Batería',     familia: 'Percusión' },
      { nombre: 'Otro',        familia: 'Otra' }
    ];
    const resInstru = await run('SELECT COUNT(*) FROM instrumentos', 'seed:instrumentos-count');
    if (parseInt(resInstru.rows[0].count, 10) === 0) {
      for (const instr of instrumentos) {
        await run(`INSERT INTO instrumentos (nombre, familia) VALUES ('${instr.nombre.replace(/'/g, "''")}', '${instr.familia.replace(/'/g, "''")}')`);
      }
      console.log('Instrumentos base insertados.');
    }

    // Grupos base (idempotente)
    const gruposBase = ['OEG','JOSG','Violín I','Violín II','Música de Cámara'];
    for (const g of gruposBase) {
      await run(
        `INSERT INTO grupos (nombre)
         SELECT '${g.replace(/'/g, "''")}'
         WHERE NOT EXISTS (SELECT 1 FROM grupos WHERE LOWER(nombre) = LOWER('${g.replace(/'/g, "''")}'))`
      );
    }
    console.log('Grupos base verificados/creados.');

    // Admin por defecto si no existe ninguno
    const rAdmin = await run(`SELECT COUNT(*)::int AS n FROM usuarios WHERE rol='admin'`, 'seed:admin-count');
    if (rAdmin.rows[0].n === 0) {
      const defaultAdmin = {
        nombre:   'Admin',
        apellidos:'Default',
        email:    process.env.ADMIN_EMAIL    || 'admin@josg.org',
        password: process.env.ADMIN_PASSWORD || 'A.12qwerty',
      };
      const hash = await bcrypt.hash(defaultAdmin.password, saltRounds);
      await run(`
        INSERT INTO usuarios (nombre, apellidos, email, password_hash, rol)
        VALUES ('${defaultAdmin.nombre}','${defaultAdmin.apellidos}','${defaultAdmin.email}','${hash}','admin')
      `);
      console.log('Usuario admin por defecto creado.');
      if (!process.env.ADMIN_PASSWORD) {
        console.log('⚠️ Usa ADMIN_PASSWORD en .env para cambiar la contraseña en producción.');
      }
    }

    // Layout ejemplo (typo arreglado)
    await run(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM layout_posiciones WHERE layout_id = 'escenario_cuerdas_v1') THEN
          INSERT INTO layout_posiciones (layout_id, instrumento, atril, puesto, x, y, angulo) VALUES
            ('escenario_cuerdas_v1','Violín',      1,1,0.10,0.35, 5),
            ('escenario_cuerdas_v1','Violín',      1,2,0.15,0.35, 5),
            ('escenario_cuerdas_v1','Violín',      2,1,0.20,0.35, 5),
            ('escenario_cuerdas_v1','Viola',       1,1,0.35,0.38, 8),
            ('escenario_cuerdas_v1','Violonchelo', 1,1,0.60,0.40,10),
            ('escenario_cuerdas_v1','Contrabajo',  1,1,0.82,0.45,15);
        END IF;
      END $$;
    `, 'seed:layout');

    await run('COMMIT', 'tx-commit');
    console.log('✅ init (producción) completado.');

  } catch (err) {
    try { await run('ROLLBACK', 'tx-rollback'); } catch {}
    console.error('❌ Error al inicializar la base de datos (producción):', err);
    throw err;
  }
}

module.exports = init;

// --------------------------------------------
// CLI directo:
//  - node database/init.js                 → init sin borrar (migración)
//  - node database/init.js --reset --yes  → DROP + init
// --------------------------------------------
if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const wantReset = args.has('--reset') || args.has('-r');
  const confirmed = args.has('--yes') || args.has('-y');

  if (wantReset && !confirmed) {
    console.error('❌ Falta confirmación. Si quieres BORRAR TODO ejecuta:');
    console.error('   node database/init.js --reset --yes');
    process.exit(1);
  }

  init({ reset: wantReset })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
