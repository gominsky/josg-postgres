// utils/fechas.js
function toISODate(input) {
    if (!input) return null;
  
    // Ya viene en ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  
    // DD/MM/YYYY
    const m = String(input).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  
    // Intento genérico (Date) → ISO (zona local ignorada)
    const d = (input instanceof Date) ? input : new Date(input);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  
  module.exports = { toISODate };
  