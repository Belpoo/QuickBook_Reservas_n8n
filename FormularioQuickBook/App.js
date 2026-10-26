/* ==========================================================================
   QuickBook · Envío de reservas al Webhook de n8n
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     CONFIGURACIÓN  (lo único que debes editar)
     - La clave NO se escribe en capturas ni en repositorios públicos.
     - El nombre del encabezado debe ser igual al de la credencial Header Auth
       del nodo Webhook en n8n.
     ------------------------------------------------------------------------ */
  const CONFIG = Object.freeze({
    WEBHOOK_URL: 'http://localhost:5678/webhook-test/QuickBook-Reserva',
    HEADER_NAME: 'X-QuickBook-Key',
    API_KEY: 'R51e32713-e956-46fa-adad-0f31af8754e6',
    TIMEOUT_MS: 30000,
    MIN_DIAS: 1,   // el If de n8n rechaza "hoy": la fecha debe ser > hoy
    MAX_DIAS: 7    // y <= hoy + 7 días
  });

  /* Valores EXACTOS que espera el Switch y el Calendar de n8n */
  const SERVICIOS = ['Consulta Medica', 'Consulta Veterinaria', 'Peluquería'];
  const HORAS = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];

  const CAMPOS = ['servicio', 'fecha_preferida', 'hora_preferida', 'nombre', 'whatsapp', 'usuario_whatsapp', 'correo'];
  const GRUPOS_RADIO = ['servicio', 'fecha_preferida', 'hora_preferida'];   // se eligen con botones

  /* ------------------------------------------------------------------------
     Referencias al DOM
     ------------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const form = $('reserva-form');
  const submitBtn = $('submit-btn');
  const submitLabel = $('submit-label');
  const live = $('live');
  const result = $('result');
  const resultTitle = $('result-title');
  const resultMessage = $('result-message');
  const resultAction = $('result-action');
  const fechaOpciones = $('fecha-options');
  const resumen = $('summary');
  const resumenTexto = $('summary-text');

  const esRadio = (id) => GRUPOS_RADIO.includes(id);
  let enviando = false;

  /* ------------------------------------------------------------------------
     Fechas (siempre en hora local; toISOString() usaría UTC y puede errar el día)
     ------------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  const aISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sumarDias = (dias) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);            // evita saltos por cambio de horario
    d.setDate(d.getDate() + dias);
    return d;
  };
  const deISO = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  };

  const fmtDia = new Intl.DateTimeFormat('es-CO', { weekday: 'short' });
  const fmtMes = new Intl.DateTimeFormat('es-CO', { month: 'short' });
  const fmtLargo = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  const sinPunto = (s) => s.replace('.', '');

  function limitesFecha() {
    return { minISO: aISO(sumarDias(CONFIG.MIN_DIAS)), maxISO: aISO(sumarDias(CONFIG.MAX_DIAS)) };
  }

  /** Dibuja los botones de día (mañana … +7). Conserva la selección si sigue vigente. */
  function dibujarDias() {
    const previo = valorBruto('fecha_preferida');
    fechaOpciones.replaceChildren();

    for (let n = CONFIG.MIN_DIAS; n <= CONFIG.MAX_DIAS; n++) {
      const fecha = sumarDias(n);
      const iso = aISO(fecha);

      const wrap = document.createElement('div');
      wrap.className = 'pick';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'fecha_preferida';
      input.id = `f-${iso}`;
      input.value = iso;
      input.required = true;
      input.className = 'pick__input';
      input.checked = iso === previo;

      const label = document.createElement('label');
      label.className = 'chip chip--day';
      label.htmlFor = input.id;

      const dow = document.createElement('span');
      dow.className = 'chip__dow';
      dow.textContent = sinPunto(fmtDia.format(fecha));
      const dia = document.createElement('span');
      dia.className = 'chip__day';
      dia.textContent = String(fecha.getDate());
      const mes = document.createElement('span');
      mes.className = 'chip__mon';
      mes.textContent = sinPunto(fmtMes.format(fecha));

      label.append(dow, dia, mes);
      wrap.append(input, label);
      fechaOpciones.append(wrap);
    }
  }

  /* ------------------------------------------------------------------------
     Lectura de valores, normalización y validación (espejo de las reglas de n8n)
     ------------------------------------------------------------------------ */
  function valorBruto(id) {
    if (esRadio(id)) {
      const marcado = form.querySelector(`input[name="${id}"]:checked`);
      return marcado ? marcado.value : '';
    }
    return $(id).value;
  }

  const limpiarEspacios = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  const normalizadores = {
    servicio: (v) => String(v ?? ''),
    fecha_preferida: (v) => String(v ?? '').trim(),
    hora_preferida: (v) => String(v ?? ''),
    nombre: limpiarEspacios,
    whatsapp: (v) => String(v ?? '').replace(/[\s\-().]/g, ''),
    usuario_whatsapp: (v) => String(v ?? '').trim(),
    correo: (v) => String(v ?? '').trim().toLowerCase()
  };

  const validadores = {
    servicio: (v) => (SERVICIOS.includes(v) ? '' : 'Selecciona un servicio.'),

    fecha_preferida: (v) => {
      if (!v) return 'Elige un día.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'El día no es válido.';
      const { minISO, maxISO } = limitesFecha();
      if (v < minISO || v > maxISO) return 'Elige un día entre mañana y los próximos 7 días.';
      return '';
    },

    hora_preferida: (v) => (HORAS.includes(v) ? '' : 'Selecciona una hora.'),

    nombre: (v) => {
      if (!v) return 'Escribe tu nombre completo.';
      if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{1,79}$/u.test(v)) return 'Usa solo letras, sin números ni símbolos (mínimo 2 caracteres).';
      return '';
    },

    whatsapp: (v) => {
      if (!v) return 'Escribe tu número de WhatsApp.';
      if (!/^\+?\d{7,15}$/.test(v)) return 'Escribe entre 7 y 15 dígitos, por ejemplo +573001234567.';
      return '';
    },

    usuario_whatsapp: (v) => {
      if (!v) return '';   // opcional
      if (!/^[\p{L}\p{N}._@-]{2,40}$/u.test(v)) return 'Usa letras, números, punto, guion o guion bajo.';
      return '';
    },

    correo: (v) => {
      if (!v) return 'Escribe tu correo electrónico.';
      if (v.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Escribe un correo válido, por ejemplo nombre@correo.com.';
      return '';
    }
  };

  const leerCampo = (id) => normalizadores[id](valorBruto(id));

  function mostrarError(id, mensaje) {
    const el = $(id);
    const p = $(`${id}-error`);
    if (mensaje) {
      p.textContent = mensaje;
      p.hidden = false;
      if (esRadio(id)) el.dataset.invalid = 'true';
      else el.setAttribute('aria-invalid', 'true');
    } else {
      p.textContent = '';
      p.hidden = true;
      if (esRadio(id)) delete el.dataset.invalid;
      else el.removeAttribute('aria-invalid');
    }
  }

  function hayError(id) {
    return esRadio(id) ? $(id).dataset.invalid === 'true' : $(id).getAttribute('aria-invalid') === 'true';
  }

  function validarCampo(id) {
    const error = validadores[id](leerCampo(id));
    mostrarError(id, error);
    return error;
  }

  function enfocarCampo(id) {
    if (esRadio(id)) {
      const destino = form.querySelector(`input[name="${id}"]`);
      $(id).scrollIntoView({ block: 'center' });
      if (destino) destino.focus({ preventScroll: true });
    } else {
      $(id).focus();
    }
  }

  /** Devuelve { datos, primerError } con los valores ya normalizados */
  function recolectar() {
    const datos = {};
    let primerError = null;
    for (const id of CAMPOS) {
      datos[id] = leerCampo(id);
      if (validarCampo(id) && !primerError) primerError = id;
    }
    return { datos, primerError };
  }

  /* ------------------------------------------------------------------------
     Interfaz: resumen, resultado y estado de envío
     ------------------------------------------------------------------------ */
  function actualizarResumen() {
    const partes = [];
    const servicio = form.querySelector('input[name="servicio"]:checked');
    const fecha = valorBruto('fecha_preferida');
    const hora = valorBruto('hora_preferida');

    if (servicio) partes.push(servicio.dataset.label);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) partes.push(fmtLargo.format(deISO(fecha)));
    if (hora) partes.push(`${hora} h`);

    resumenTexto.textContent = partes.length ? partes.join(' · ') : 'Elige servicio, día y hora.';
    resumen.classList.toggle('is-ready', partes.length === 3);
  }

  function mostrarResultado(tipo, titulo, mensaje) {
    // tipo: 'ok' | 'bad'.  Siempre textContent: nunca innerHTML con datos externos.
    result.dataset.state = tipo;
    result.setAttribute('role', tipo === 'ok' ? 'status' : 'alert');
    resultTitle.textContent = titulo;
    resultMessage.textContent = mensaje;
    resultAction.hidden = tipo !== 'ok';
    result.hidden = false;
    result.scrollIntoView({ block: 'center' });
    result.focus({ preventScroll: true });
  }

  function ocultarResultado() {
    result.hidden = true;
    resultTitle.textContent = '';
    resultMessage.textContent = '';
  }

  function setEnviando(valor) {
    enviando = valor;
    submitBtn.disabled = valor;
    form.setAttribute('aria-busy', String(valor));
    submitLabel.textContent = valor ? 'Reservando…' : 'Confirmar reserva';
    live.textContent = valor ? 'Enviando tu reserva…' : '';
  }

  /* ------------------------------------------------------------------------
     Llamada al Webhook de n8n
     ------------------------------------------------------------------------ */
  class ErrorServicio extends Error { }

  async function enviarReserva(datos) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);

    try {
      const resp = await fetch(CONFIG.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CONFIG.HEADER_NAME]: CONFIG.API_KEY
        },
        body: JSON.stringify(datos),
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal
      });

      if (resp.status === 401 || resp.status === 403) {
        console.error('[QuickBook] El Webhook rechazó la clave (HTTP ' + resp.status + ').');
        throw new ErrorServicio('No pudimos autorizar tu solicitud. Avisa al negocio para que revise la configuración.');
      }
      if (resp.status === 404) {
        console.error('[QuickBook] Webhook no encontrado: ¿el flujo está publicado y la URL es /webhook/?');
        throw new ErrorServicio('El servicio de reservas no está disponible en este momento. Inténtalo más tarde.');
      }
      if (!resp.ok) {
        throw new ErrorServicio('El servicio de reservas tuvo un problema. Inténtalo de nuevo en unos minutos.');
      }

      let json;
      try {
        json = await resp.json();
      } catch {
        throw new ErrorServicio('Recibimos una respuesta inesperada del servicio. Inténtalo de nuevo.');
      }

      const estado = json && json.estado;
      const mensaje = json && json.mensaje;
      if ((estado !== 'Confirmado' && estado !== 'Rechazado') || typeof mensaje !== 'string' || !mensaje.trim()) {
        throw new ErrorServicio('Recibimos una respuesta inesperada del servicio. Inténtalo de nuevo.');
      }

      return { estado, mensaje: mensaje.trim().slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------------
     Eventos
     ------------------------------------------------------------------------ */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (enviando) return;

    ocultarResultado();
    dibujarDias();              // por si la página quedó abierta de un día para otro
    actualizarResumen();

    const { datos, primerError } = recolectar();
    if (primerError) {
      enfocarCampo(primerError);
      return;
    }

    if (!CONFIG.API_KEY || CONFIG.API_KEY === 'REEMPLAZAR_CLAVE') {
      console.error('[QuickBook] Falta configurar API_KEY en app.js.');
      mostrarResultado('bad', 'Falta configurar el formulario', 'El administrador debe agregar la clave de acceso antes de recibir reservas.');
      return;
    }

    setEnviando(true);
    try {
      const { estado, mensaje } = await enviarReserva(datos);
      if (estado === 'Confirmado') {
        form.hidden = true;
        mostrarResultado('ok', '¡Reserva confirmada!', mensaje);
      } else {
        mostrarResultado('bad', 'No pudimos reservar tu cita', mensaje);
      }
    } catch (err) {
      let mensaje;
      if (err instanceof ErrorServicio) {
        mensaje = err.message;
      } else if (err && err.name === 'AbortError') {
        mensaje = 'La respuesta está tardando más de lo normal. Antes de intentarlo otra vez, confirma con el negocio si tu reserva quedó registrada.';
      } else {
        console.error('[QuickBook] Error de red o CORS:', err);
        mensaje = 'No pudimos conectar con el servicio de reservas. Revisa tu conexión e inténtalo de nuevo.';
      }
      mostrarResultado('bad', 'No se pudo enviar tu reserva', mensaje);
    } finally {
      setEnviando(false);
    }
  });

  // Campos de texto: validar al salir y corregir en vivo si ya tenían error
  for (const id of CAMPOS.filter((c) => !esRadio(c))) {
    $(id).addEventListener('blur', () => validarCampo(id));
    $(id).addEventListener('input', () => { if (hayError(id)) validarCampo(id); });
  }

  // Botones de elección: al cambiar, se valida el grupo y se actualiza el resumen
  for (const id of GRUPOS_RADIO) {
    $(id).addEventListener('change', () => {
      validarCampo(id);
      actualizarResumen();
    });
  }

  resultAction.addEventListener('click', () => {
    form.reset();
    for (const id of CAMPOS) mostrarError(id, '');
    ocultarResultado();
    form.hidden = false;
    dibujarDias();
    actualizarResumen();
    window.scrollTo({ top: 0 });
    form.querySelector('input[name="servicio"]').focus({ preventScroll: true });
  });

  dibujarDias();
  actualizarResumen();
})();