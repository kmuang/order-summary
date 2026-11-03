(() => {
  const KEY = "studio-shop-cart";

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((row) => ({
          id: Number(row.id),
          quantity: Number(row.quantity),
        }))
        .filter(
          (row) =>
            Number.isInteger(row.id) &&
            Number.isInteger(row.quantity) &&
            row.quantity > 0 &&
            row.quantity <= 99
        );
    } catch {
      return [];
    }
  }

  function save(rows) {
    const compact = rows
      .filter((row) => row.quantity > 0)
      .map((row) => ({ id: row.id, quantity: row.quantity }));
    localStorage.setItem(KEY, JSON.stringify(compact));
    paint();
  }

  function clear() {
    localStorage.removeItem(KEY);
    paint();
  }

  function paint() {
    const count = load().reduce((sum, row) => sum + row.quantity, 0);
    document.querySelectorAll("[data-cart-count]").forEach((el) => {
      el.textContent = String(count);
    });
  }

  window.StudioCart = { load, save, clear, paint };
  document.addEventListener("DOMContentLoaded", paint);
})();
