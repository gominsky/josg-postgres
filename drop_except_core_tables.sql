-- drop_except_core_tables.sql
--
-- Elimina todas las tablas del esquema activo EXCEPTO:
--   alumnos, alumno_grupo (o alumnos_grupos), alumno_instrumento (o alumno_instrumentos), grupos, instrumentos.
--
-- ⚠️ ADVERTENCIA: Usa esto con copia de seguridad. DROP ... CASCADE eliminará también FKs, vistas y triggers dependientes.
--
-- Por defecto trabaja sobre el esquema activo (current_schema()).
-- Si quieres forzar el esquema público, descomenta la siguiente línea:
-- SET search_path TO public;
-- -----------------------------------------------------------------------------

-- 1) Vista previa (no elimina nada): muestra los DROP que se ejecutarían
WITH to_drop AS (
  SELECT format('%I.%I', n.nspname, c.relname) AS fqname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind IN ('r','p')  -- 'r' tabla normal, 'p' tabla particionada
    AND c.relname <> ALL (ARRAY[
      'alumnos','alumno_grupo','alumno_instrumento','grupos','instrumentos',
      'alumnos_grupos','alumno_instrumentos'  -- variantes por si existieran
    ])
)
SELECT 'DROP TABLE IF EXISTS ' || fqname || ' CASCADE;' AS preview_drop_stmt
FROM to_drop
ORDER BY fqname;

-- 2) Ejecución: elimina con CASCADE todo lo que no esté en la lista de exclusión
DO $$
DECLARE
  keep CONSTANT text[] := ARRAY[
    'alumnos','alumno_grupo','alumno_instrumento','grupos','instrumentos',
    'alumnos_grupos','alumno_instrumentos'  -- tolera nombres alternativos
  ];
  rec record;
BEGIN
  FOR rec IN
    SELECT format('%I.%I', n.nspname, c.relname) AS fqname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r','p')
      AND c.relname <> ALL (keep)
    ORDER BY c.relname
  LOOP
    RAISE NOTICE 'Dropping %', rec.fqname;
    EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', rec.fqname);
  END LOOP;
END $$;
