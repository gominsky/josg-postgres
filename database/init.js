const db = require('./db');
const bcrypt = require('bcrypt');
const saltRounds = 10;

async function init() {
  try {
    // Crear tablas
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rol TEXT CHECK(rol IN ('admin','docente','usuario')) NOT NULL DEFAULT 'usuario',
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumnos (
        id SERIAL PRIMARY KEY,
        nombre TEXT,
        apellidos TEXT,
        tutor TEXT,
        direccion TEXT,
        codigo_postal INTEGER,
        municipio TEXT,
        provincia TEXT,
        telefono TEXT,
        email TEXT,
        fecha_nacimiento TEXT,
        DNI TEXT,
        centro TEXT,
        profesor_centro TEXT,
        repertorio_id INTEGER,
        foto TEXT,
        activo BOOLEAN DEFAULT TRUE,
        password TEXT DEFAULT NULL,
        registrado BOOLEAN DEFAULT FALSE,
        guardias_actual INTEGER DEFAULT 0,
        guardias_hist INTEGER DEFAULT 0,
        fecha_matriculacion TEXT,
        fecha_baja TEXT
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesores (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        fecha_nacimiento TEXT,
        telefono TEXT,
        direccion TEXT,
        especialidad TEXT,
        foto TEXT,
        activo BOOLEAN DEFAULT TRUE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS instrumentos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL UNIQUE,
        familia TEXT CHECK(familia IN ('Cuerda','Percusión','Viento madera','Viento metal', 'Otra')) DEFAULT 'Otra'
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumno_instrumento (
        alumno_id INTEGER,
        instrumento_id INTEGER,
        PRIMARY KEY (alumno_id, instrumento_id),
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesor_instrumento (
        profesor_id INTEGER,
        instrumento_id INTEGER,
        PRIMARY KEY (profesor_id, instrumento_id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS grupos (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        descripcion TEXT
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS alumno_grupo (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        grupo_id INTEGER NOT NULL,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS profesor_grupo (
        profesor_id INTEGER,
        grupo_id INTEGER,
        PRIMARY KEY (profesor_id, grupo_id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id),
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS eventos (
        id SERIAL PRIMARY KEY,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha_inicio TEXT NOT NULL,
        fecha_fin TEXT NOT NULL,
        hora_inicio TEXT,
        hora_fin TEXT,
        observaciones TEXT,
        grupo_id INTEGER NOT NULL,
        token TEXT,
        activo BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (grupo_id) REFERENCES grupos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS asistencias (
        id SERIAL PRIMARY KEY,
        evento_id INTEGER NOT NULL,
        alumno_id INTEGER NOT NULL,
        fecha TEXT,
        hora TEXT,
        ubicacion TEXT,
        observaciones TEXT,
        tipo TEXT DEFAULT 'qr',
        FOREIGN KEY (evento_id) REFERENCES eventos(id),
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        CONSTRAINT asistencias_alumno_evento_uniq UNIQUE (alumno_id, evento_id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS guardias (
        id SERIAL PRIMARY KEY,
        evento_id INTEGER NOT NULL,
        fecha TEXT NOT NULL,
        alumno_id_1 INTEGER NOT NULL,
        alumno_id_2 INTEGER NOT NULL,
        notas TEXT,
        curso TEXT,
        FOREIGN KEY (evento_id) REFERENCES eventos(id),
        FOREIGN KEY (alumno_id_1) REFERENCES alumnos(id),
        FOREIGN KEY (alumno_id_2) REFERENCES alumnos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS tipos_cuota (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL UNIQUE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS cuotas (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        precio NUMERIC NOT NULL,
        descripcion TEXT,
        tipo_id INTEGER NOT NULL,
        FOREIGN KEY (tipo_id) REFERENCES tipos_cuota(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS cuotas_alumno (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        cuota_id INTEGER NOT NULL,
        pagado BOOLEAN DEFAULT FALSE,
        fecha_vencimiento TEXT,
        fecha_pago TEXT,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (cuota_id) REFERENCES cuotas(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS pagos (
        id SERIAL PRIMARY KEY,
        alumno_id INTEGER NOT NULL,
        importe NUMERIC NOT NULL,
        fecha_pago TEXT NOT NULL,
        medio_pago TEXT,
        referencia TEXT,
        observaciones TEXT,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS pago_cuota_alumno (
        id SERIAL PRIMARY KEY,
        pago_id INTEGER NOT NULL,
        cuota_alumno_id INTEGER NOT NULL,
        importe_aplicado NUMERIC NOT NULL,
        FOREIGN KEY (pago_id) REFERENCES pagos(id),
        FOREIGN KEY (cuota_alumno_id) REFERENCES cuotas_alumno(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informes (
        id SERIAL PRIMARY KEY,
        informe TEXT NOT NULL,
        grupo_id INTEGER,
        instrumento_id INTEGER,
        profesor_id INTEGER,
        fecha TEXT DEFAULT CURRENT_DATE,
        observaciones TEXT,
        FOREIGN KEY (grupo_id) REFERENCES grupos(id),
        FOREIGN KEY (instrumento_id) REFERENCES instrumentos(id),
        FOREIGN KEY (profesor_id) REFERENCES profesores(id)
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informe_campos (
        id SERIAL PRIMARY KEY,
        informe_id INTEGER NOT NULL,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        obligatorio BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS informe_resultados (
        id SERIAL PRIMARY KEY,
        informe_id INTEGER NOT NULL,
        alumno_id INTEGER,
        campo_id INTEGER NOT NULL,
        valor TEXT,
        fila INTEGER,
        FOREIGN KEY (informe_id) REFERENCES informes(id) ON DELETE CASCADE,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id) ON DELETE CASCADE,
        FOREIGN KEY (campo_id) REFERENCES informe_campos(id) ON DELETE CASCADE
      );
    `);

    // CONTABILIDAD: ESQUEMA BÁSICO

    // Función + trigger genérico para updated_at
    await db.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ---------- PROVEEDORES ----------
    await db.query(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id          SERIAL PRIMARY KEY,
        nombre      TEXT NOT NULL,
        cif         TEXT,
        email       TEXT,
        telefono    TEXT,
        direccion   TEXT,
        municipio   TEXT,
        provincia   TEXT,
        codigo_postal TEXT,
        iban        TEXT,
        contacto    TEXT,
        notas       TEXT,
        activo      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_proveedores_updated_at') THEN
          CREATE TRIGGER trg_proveedores_updated_at
          BEFORE UPDATE ON proveedores
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$;
    `);

    // ---------- CATEGORÍAS DE GASTO (jerárquicas opcionales) ----------
    await db.query(`
      CREATE TABLE IF NOT EXISTS categorias_gasto (
        id       SERIAL PRIMARY KEY,
        nombre   TEXT NOT NULL,
        codigo   TEXT,
        padre_id INT REFERENCES categorias_gasto(id) ON DELETE SET NULL
      );
    `);

    // ---------- CUENTAS (banco / caja) ----------
    await db.query(`
      CREATE TABLE IF NOT EXISTS cuentas (
        id             SERIAL PRIMARY KEY,
        nombre         TEXT NOT NULL,
        tipo           TEXT NOT NULL CHECK (tipo IN ('banco','caja')),
        iban           TEXT,
        saldo_inicial  NUMERIC(12,2) DEFAULT 0,
        fecha_saldo    DATE,
        activo         BOOLEAN NOT NULL DEFAULT TRUE
      );
    `);

    // ---------- FACTURAS RECIBIDAS (proveedores) ----------
    await db.query(`
      CREATE TABLE IF NOT EXISTS facturas_prov (
        id                SERIAL PRIMARY KEY,
        proveedor_id      INT NOT NULL REFERENCES proveedores(id),
        categoria_id      INT REFERENCES categorias_gasto(id),
        cuenta_id         INT REFERENCES cuentas(id),       -- cuenta sugerida (opcional)
        numero            TEXT NOT NULL,                    -- Nº factura del proveedor
        fecha_emision     DATE NOT NULL,
        fecha_vencimiento DATE,
        concepto          TEXT,
        base_imponible    NUMERIC(12,2) NOT NULL DEFAULT 0,
        iva_pct           NUMERIC(5,2)  NOT NULL DEFAULT 21,
        total             NUMERIC(12,2) NOT NULL,           -- base + IVA
        estado            TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('borrador','pendiente','parcial','pagada','anulada')),
        adjunto_path      TEXT,
        notas             TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_proveedor   ON facturas_prov(proveedor_id);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_estado      ON facturas_prov(estado);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_vencimiento ON facturas_prov(fecha_vencimiento);
      CREATE INDEX IF NOT EXISTS idx_facturas_prov_numero      ON facturas_prov(numero);
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_facturas_prov_updated_at') THEN
          CREATE TRIGGER trg_facturas_prov_updated_at
          BEFORE UPDATE ON facturas_prov
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$;
    `);

    // ---------- PAGOS DE PROVEEDORES (parciales o totales) ----------
    // Nota: se llama pagos_prov para no colisionar con tu tabla "pagos" de alumnos
    await db.query(`
      CREATE TABLE IF NOT EXISTS pagos_prov (
        id             SERIAL PRIMARY KEY,
        proveedor_id   INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
        cuenta_id      INTEGER REFERENCES cuentas(id),           -- NULL permitido (UI actual)
        fecha          DATE NOT NULL DEFAULT CURRENT_DATE,
        importe_total  NUMERIC(12,2) NOT NULL CHECK (importe_total >= 0),
        metodo         TEXT NOT NULL CHECK (metodo IN ('transferencia','tarjeta','efectivo','domiciliacion','otro')),
        referencia     TEXT,
        notas          TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      );

      -- Si creaste 'importe' por error, renómbralo:
      -- ALTER TABLE pagos_prov RENAME COLUMN importe TO importe_total;

      -- Índices útiles
      CREATE INDEX IF NOT EXISTS idx_pagos_prov_proveedor ON pagos_prov(proveedor_id);
      CREATE INDEX IF NOT EXISTS idx_pagos_prov_fecha     ON pagos_prov(fecha);
    `);

    // ---------- Semillas mínimas de cuentas (si no existen) ----------
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM cuentas WHERE nombre = 'Banco') THEN
          INSERT INTO cuentas (nombre, tipo) VALUES ('Banco', 'banco');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM cuentas WHERE nombre = 'Caja') THEN
          INSERT INTO cuentas (nombre, tipo) VALUES ('Caja', 'caja');
        END IF;
      END $$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS pagos_prov_aplicaciones (
        id              SERIAL PRIMARY KEY,
        pago_id         INTEGER NOT NULL REFERENCES pagos_prov(id) ON DELETE CASCADE,
        factura_id      INTEGER NOT NULL REFERENCES facturas_prov(id) ON DELETE CASCADE,
        importe_aplicado NUMERIC(12,2) NOT NULL CHECK (importe_aplicado >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_pagos_apl_factura ON pagos_prov_aplicaciones(factura_id);
      CREATE INDEX IF NOT EXISTS idx_pagos_apl_pago    ON pagos_prov_aplicaciones(pago_id);
      `);    
    
     await db.query(`
      CREATE TABLE IF NOT EXISTS factura_adjuntos (
        id            SERIAL PRIMARY KEY,
        factura_id    INTEGER NOT NULL REFERENCES facturas_prov(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        original_name TEXT,
        mime          TEXT,
        size_bytes    INTEGER,
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_adjuntos_factura ON factura_adjuntos(factura_id);
    `); 
    await db.query(`
      CREATE OR REPLACE VIEW v_factura_sumas_pagos AS
      SELECT
        f.id AS factura_id,
        COALESCE(SUM(a.importe_aplicado),0)::NUMERIC(12,2) AS pagado,
        GREATEST(f.total - COALESCE(SUM(a.importe_aplicado),0), 0)::NUMERIC(12,2) AS saldo
      FROM facturas_prov f
      LEFT JOIN pagos_prov_aplicaciones a ON a.factura_id = f.id
      GROUP BY f.id; 
    `);   
    // ================================
// HARDENING CONTABILIDAD (índices + constraints + trigger)
// ================================

// 1) Índices adicionales útiles para tus consultas y listados
await db.query(`
  CREATE INDEX IF NOT EXISTS idx_facturas_prov_fecha_emision
    ON facturas_prov (fecha_emision);

  CREATE INDEX IF NOT EXISTS idx_facturas_prov_proveedor_estado
    ON facturas_prov (proveedor_id, estado);
`);

// 2) Constraints idempotentes en facturas_prov
await db.query(`
  DO $$
  BEGIN
    -- Evitar totales negativos
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'chk_fact_total_nonneg'
    ) THEN
      ALTER TABLE facturas_prov
        ADD CONSTRAINT chk_fact_total_nonneg CHECK (total >= 0);
    END IF;

    -- Evitar duplicados (mismo proveedor + número de factura)
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'uniq_factura_prov_num'
    ) THEN
      ALTER TABLE facturas_prov
        ADD CONSTRAINT uniq_factura_prov_num UNIQUE(proveedor_id, numero);
    END IF;
  END $$;
`);

// 3) Trigger anti-sobrepago en pagos_prov_aplicaciones (con tolerancia 0,01 €)
await db.query(`
  DO $$
  BEGIN
    -- Crear función del trigger si no existe
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_chk_aplicaciones_factura') THEN
      CREATE OR REPLACE FUNCTION trg_chk_aplicaciones_factura()
      RETURNS TRIGGER AS $fn$
      DECLARE
        v_total    NUMERIC(12,2);
        v_aplicado NUMERIC(12,2);
        v_eps      NUMERIC := 0.01; -- tolerancia
      BEGIN
        -- Bloquea la factura para evitar condiciones de carrera
        SELECT total INTO v_total
          FROM facturas_prov
         WHERE id = NEW.factura_id
         FOR UPDATE;

        IF v_total IS NULL THEN
          RAISE EXCEPTION 'Factura % no encontrada', NEW.factura_id
            USING ERRCODE = '23503';
        END IF;

        -- Suma actual de aplicaciones (excluye la propia si UPDATE)
        SELECT COALESCE(SUM(importe_aplicado),0)
          INTO v_aplicado
          FROM pagos_prov_aplicaciones
         WHERE factura_id = NEW.factura_id
           AND (TG_OP <> 'UPDATE' OR id <> COALESCE(OLD.id, -1));

        v_aplicado := v_aplicado + NEW.importe_aplicado;

        IF v_aplicado - v_total > v_eps THEN
          RAISE EXCEPTION 'Aplicaciones (%.2f) superan total (%.2f) para factura %',
            v_aplicado, v_total, NEW.factura_id
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    END IF;

    -- Crear el trigger si no existe
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pagos_apl_chk_total') THEN
      CREATE TRIGGER pagos_apl_chk_total
      BEFORE INSERT OR UPDATE ON pagos_prov_aplicaciones
      FOR EACH ROW
      EXECUTE FUNCTION trg_chk_aplicaciones_factura();
    END IF;
  END $$;
`);

// ============ PLANO DE ORQUESTA: tabla + índices ============

await db.query(`
  CREATE TABLE IF NOT EXISTS layout_posiciones (
    id         SERIAL PRIMARY KEY,
    layout_id  TEXT    NOT NULL,
    instrumento TEXT   NOT NULL,
    atril      INT     NOT NULL,
    puesto     INT     NOT NULL,
    x          NUMERIC NOT NULL,   -- 0..1 respecto al ancho
    y          NUMERIC NOT NULL,   -- 0..1 respecto al alto
    angulo     NUMERIC DEFAULT 0,
    CONSTRAINT uq_layout_pos UNIQUE (layout_id, instrumento, atril, puesto),
    CONSTRAINT ck_xy_range CHECK (x >= 0 AND x <= 1 AND y >= 0 AND y <= 1)
  );
`);

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_layout_pos_layout
    ON layout_posiciones (layout_id);
  CREATE INDEX IF NOT EXISTS idx_layout_pos_lookup
    ON layout_posiciones (layout_id, instrumento, atril, puesto);
`);


// ============ ÍNDICES para informes (aceleran la vista normalizada) ============

await db.query(`
  CREATE INDEX IF NOT EXISTS idx_informes_informe
    ON informes (informe);
  CREATE INDEX IF NOT EXISTS idx_inf_campos_informe_nombre
    ON informe_campos (informe_id, nombre);
  CREATE INDEX IF NOT EXISTS idx_inf_resultados_fk
    ON informe_resultados (informe_id, campo_id, fila);
`);


// ============ Seed del layout (solo si está vacío) + fix de typo ============

await db.query(`
  DO $$
  BEGIN
    IF (SELECT COUNT(*) FROM layout_posiciones) = 0 THEN
      INSERT INTO layout_posiciones(layout_id,instrumento,atril,puesto,x,y,angulo) VALUES
        ('escenario_cuerdas_v1','Violín I',    1,1,0.22,0.22,-15),
        ('escenario_cuerdas_v1','Violín I',    1,2,0.27,0.22,-15),
        ('escenario_cuerdas_v1','Violín I',    2,1,0.20,0.30,-10),
        ('escenario_cuerdas_v1','Violín I',    2,2,0.28,0.30,-10),

        ('escenario_cuerdas_v1','Violín II',   1,1,0.38,0.24,0),
        ('escenario_cuerdas_v1','Violín II',   1,2,0.43,0.24,0),

        ('escenario_cuerdas_v1','Viola',       1,1,0.55,0.30,5),
        ('escenario_cuerdas_v1','Viola',       1,2,0.60,0.30,5),

        ('escenario_cuerdas_v1','Violonchelo', 1,1,0.68,0.40,10),
        ('escenario_cuerdas_v1','Violonchelo', 1,2,0.73,0.40,10),

        ('escenario_cuerdas_v1','Contrabajo',  1,1,0.82,0.45,15),
        ('escenario_cuerdas_v1','Contrabajo',  1,2,0.87,0.45,15)
      ON CONFLICT (layout_id, instrumento, atril, puesto) DO NOTHING;
    END IF;

    -- Corrige posibles filas con el layout mal escrito
    UPDATE layout_posiciones
       SET layout_id = 'escenario_cuerdas_v1'
     WHERE layout_id = 'escenario_cuerzas_v1';
  END $$;
`);
await db.query(`
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
`);
    // ============ FIN AÑADIDOS ============

    // Sembrar usuario admin si no existe
    const result = await db.query("SELECT COUNT(*) FROM usuarios WHERE rol = 'admin'");
    if (parseInt(result.rows[0].count) === 0) {
      const defaultAdmin = {
        nombre: 'Admin',
        apellidos: 'Default',
        email: 'admin@josg.org',
        password: 'A.12qwerty'
      };
      const hash = await bcrypt.hash(defaultAdmin.password, saltRounds);
      await db.query(
        "INSERT INTO usuarios (nombre, apellidos, email, password, rol) VALUES ($1, $2, $3, $4, 'admin')",
        [defaultAdmin.nombre, defaultAdmin.apellidos, defaultAdmin.email, hash]
      );
      console.log("Usuario admin por defecto creado.");
    }

    // 🏛️ GRUPOS BASE
    const grupos = [
      'OEG',
      'JOSG',
      'Violín I',
      'Violín II',
      'Música de Cámara'
    ];

    const resGrupos = await db.query('SELECT COUNT(*) FROM grupos');
    if (parseInt(resGrupos.rows[0].count) === 0) {
      for (const nombre of grupos) {
        await db.query('INSERT INTO grupos (nombre) VALUES ($1)', [nombre]);
      }
      console.log("Grupos base insertados.");
    }

    // 💳 TIPOS DE CUOTA
    const tiposCuota = ['Mensual', 'Semanal', 'Puntual', 'Otra'];

    const resTipos = await db.query('SELECT COUNT(*) FROM tipos_cuota');
    if (parseInt(resTipos.rows[0].count) === 0) {
      for (const tipo of tiposCuota) {
        await db.query('INSERT INTO tipos_cuota (tipo) VALUES ($1)', [tipo]);
      }
      console.log("Tipos de cuota insertados.");
    }

    // 💰 CUOTAS BASE
    const cuotasBase = [
      { nombre: 'Mensualidad', precio: 50, tipo: 'Mensual' },
      { nombre: 'Extraordinaria', precio: 100, tipo: 'Puntual' },
      { nombre: 'Matrícula', precio: 100, tipo: 'Puntual' }
    ];

    const resCuotas = await db.query('SELECT COUNT(*) FROM cuotas');
    if (parseInt(resCuotas.rows[0].count) === 0) {
      for (const cuota of cuotasBase) {
        const tipoId = await db.query('SELECT id FROM tipos_cuota WHERE tipo = $1', [cuota.tipo]);
        if (tipoId.rows.length > 0) {
          await db.query(
            'INSERT INTO cuotas (nombre, precio, tipo_id) VALUES ($1, $2, $3)',
            [cuota.nombre, cuota.precio, tipoId.rows[0].id]
          );
        }
      }
      console.log("Cuotas base insertadas.");
    }

    // 🎻 INSTRUMENTOS BASE
    const instrumentos = [
      { nombre: 'Violín', familia: 'Cuerda' },
      { nombre: 'Viola', familia: 'Cuerda' },
      { nombre: 'Violonchelo', familia: 'Cuerda' },
      { nombre: 'Contrabajo', familia: 'Cuerda' },
      { nombre: 'Flauta', familia: 'Viento madera' },
      { nombre: 'Oboe', familia: 'Viento madera' },
      { nombre: 'Clarinete', familia: 'Viento madera' },
      { nombre: 'Fagot', familia: 'Viento madera' },
      { nombre: 'Trompeta', familia: 'Viento metal' },
      { nombre: 'Trompa', familia: 'Viento metal' },
      { nombre: 'Trombón', familia: 'Viento metal' },
      { nombre: 'Tuba', familia: 'Viento metal' },
      { nombre: 'Percusión', familia: 'Percusión' },
      { nombre: 'Batería', familia: 'Percusión' }
    ];

    const resInstru = await db.query('SELECT COUNT(*) FROM instrumentos');
    if (parseInt(resInstru.rows[0].count) === 0) {
      for (const instr of instrumentos) {
        await db.query(
          'INSERT INTO instrumentos (nombre, familia) VALUES ($1, $2)',
          [instr.nombre, instr.familia]
        );
      }
      console.log("Instrumentos base insertados.");
    }
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err);
  }
}
module.exports = init;