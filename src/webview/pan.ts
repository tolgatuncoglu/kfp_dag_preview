export function enablePanning(canvas: HTMLElement): void {
  let pointer: { id: number; x: number; y: number; left: number; top: number } | undefined;
  let dragging = false;
  let suppressClick = false;

  function finish(event: PointerEvent): void {
    if (event.pointerId !== pointer?.id) return;
    pointer = undefined;
    dragging = false;
    canvas.classList.remove('panning');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || pointer) return;
    suppressClick = false;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!(event.buttons & 1)) { finish(event); return; }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!dragging && Math.hypot(dx, dy) < 6) return;
    if (!dragging) {
      dragging = true;
      suppressClick = true;
      // Capturing only after the threshold preserves the node target for normal clicks.
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('panning');
    }
    event.preventDefault();
    canvas.scrollLeft = pointer.left - dx;
    canvas.scrollTop = pointer.top - dy;
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    canvas.addEventListener(event, finish);
  }
  canvas.addEventListener('pointerleave', (event) => {
    if (!dragging) finish(event);
  });
  canvas.addEventListener('click', (event) => {
    if (!suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, true);
  canvas.addEventListener('dragstart', (event) => event.preventDefault());
}
