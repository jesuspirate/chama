// Spanish (LATAM) FAQ content — mirrors faq.en.ts string-for-string (same section
// ids, same item counts, same step counts). Voice + terminology seeded from
// landing/faq.es.html and the locked ES glossary in src/i18n/es/.
import type { FaqContent } from "./faq-types.js";

export const faqEs: FaqContent = {
  intro:
    "Intercambia Bitcoin, bienes y servicios con tu comunidad. Un chama es un círculo de ahorro de África Oriental; aquí, los intercambios usan ecash emitido por una federación o custodia directa en Bitcoin. Chama no tiene el dinero; la tabla de abajo indica quién lo tiene.",
  sections: [
    {
      id: "basics",
      title: "Lo básico",
      items: [
        { q: "¿Qué es Chama?", a: "Un mercado entre pares para Bitcoin, bienes y servicios en tu comunidad. Los intercambios usan ecash emitido por una federación o custodia directa en Bitcoin. Antes de aportar fondos ves quién los tiene y las condiciones del intercambio." },
        { q: "¿Necesito saber algo de Bitcoin?", a: "No. Eliges tu país y tu moneda, comercias, y (en los países compatibles) tu dinero puede llegar directo a tu cuenta de dinero móvil como M-Pesa. Bitcoin es la tubería; no tienes que pensar en él." },
        { q: "¿Chama es gratis? ¿Cuánto cuesta?", a: "La app es gratis para descargar, y Chama en sí no se queda con nada — Chama no tiene tu dinero; el ecash está respaldado por Bitcoin en manos de los guardianes de una federación. En un intercambio completado, una pequeña prima de seguro del 0,5 % va al árbitro de la comunidad que respalda tu intercambio (0,25 % de cada lado), enviada en ecash. Está incluida por defecto y puedes desactivarla antes de cerrar. Si un intercambio pasa a un árbitro para resolver una disputa, se aplica una pequeña comisión adicional por ese trabajo. Los vendedores también pueden fijar su propia prima en una publicación (por ejemplo “+25 %”) — ese es el precio del vendedor, no una comisión de Chama — y siempre ves el monto final antes de comprometerte." },
        { q: "¿Chama guarda mi dinero?", a: "Chama no tiene tu dinero. El ecash representa Bitcoin en manos de los guardianes de la federación indicada mientras conservas sus notas. La custodia directa en Bitcoin está en el script del intercambio hasta la liquidación o el bloque de reembolso. Puedes tener un saldo ecash local entre intercambios; guardar la clave de tu cuenta no respalda ese saldo." },
      ],
    },
    {
      id: "start",
      title: "Primeros pasos",
      items: [
        { q: "¿Cómo obtengo Chama?", a: "Android: instala desde Zapstore (zapstore.dev/apps/app.chama.market). Web y escritorio: abre getchama.app (también en chama.community)." },
        { q: "¿Cómo inicio sesión?", a: "Chama usa una llave como tu cuenta (el estándar de Nostr) — no hay correo/contraseña ni formulario de registro. La app puede crear una llave por ti, o puedes usar tu llave de Nostr existente. Anota tu llave y guárdala a salvo — es tu cuenta." },
        { q: "¿Qué es una “comunidad” y cómo elijo una?", a: "Una comunidad es tu moneda + país + bandera — por ejemplo Kenia · KES, o Senegal · CFA. Eliges la tuya la primera vez que inicias sesión. Decide la moneda en que se cotizan tus intercambios y los vecinos con quienes comercias. Puedes cambiar de comunidad más adelante en Ajustes → Avanzado, pero por defecto te quedas en “casa”. También puedes echar un vistazo a otras comunidades mientras exploras." },
      ],
    },
    {
      id: "trade",
      title: "Comprar y vender",
      items: [
        { q: "¿Cómo compro algo?", a: { steps: [
          "En Explorar, toca una publicación que te interese.",
          "Toca Unirme como comprador para reservar tu lugar (todavía no se mueve nada).",
          "Arma tu pedido / confirma el monto, luego financíalo — esto bloquea tus sats en custodia.",
          "Págale al vendedor el efectivo (por ejemplo M-Pesa, Airtel) como lo indica la publicación, o recibe tus bienes.",
          "Cuando tengas lo que pagaste, toca para liberar — los sats van al vendedor. Listo.",
        ] } },
        { q: "¿Cómo vendo algo?", a: { steps: [
          "Toca Crear y publica un anuncio (Intercambio / Tiendas / Pago comunitario de facturas), fija tu precio y qué métodos de pago aceptas.",
          "Cuando un comprador se une y financia, los sats se bloquean en custodia — verás “Sats bloqueados en custodia.”",
          "Entrega los bienes / envía el efectivo acordado, luego toca Marcar como entregado (o “Marcar como enviado”) — esa es tu confirmación.",
          "Una vez liberado, toca Reclamar para recibir tus sats — y retirar.",
        ] } },
        { q: "¿Cuáles son los pasos de un intercambio?", a: "Reservado (alguien se unió) → Bloqueado (sats financiados en custodia) → sucede el trabajo (bienes entregados / efectivo enviado) → Liberado (ambas partes de acuerdo) → Reclama tu cobro → Cerrado. Puedes seguirlo en la línea de tiempo del intercambio, y chatear con la otra parte en cualquier momento." },
        { q: "¿Cómo me mantiene a salvo la custodia?", a: "Dos de los tres participantes deben aprobar el pago: comprador, vendedor y árbitro. Con ecash, esto protege el acceso a las notas; los guardianes de la federación siguen teniendo el Bitcoin que las respalda. La custodia directa en Bitcoin usa un script con una vía de reembolso para quien aportó los fondos. Estas reglas no eliminan los riesgos de la federación ni de perder el dispositivo." },
        { q: "¿Qué es un árbitro?", a: "Un miembro de confianza de tu comunidad que puede ayudar a cerrar un intercambio solo si hay una disputa. No puede quedarse con tu dinero — solo puede desempatar entre comprador y vendedor. Los árbitros construyen una reputación con el tiempo." },
        { q: "¿Qué pasa si algo sale mal / tengo una disputa?", a: "Si tú y tu contraparte no están de acuerdo (por ejemplo, los bienes nunca llegaron), cada uno emite su voto — liberar o reembolsar — y explica por qué. Si chocan, se llama al árbitro para que decida con justicia. Nunca te quedas atascado." },
        { q: "¿Cómo cancelo o me echo atrás?", a: "Antes de que algo se financie, puedes simplemente salir. Después de financiar, echarte atrás significa emitir un voto de reembolso, que devuelve los sats a la persona correcta (el árbitro es el respaldo). Chama siempre te muestra exactamente a dónde va el dinero antes de que confirmes." },
      ],
    },
    {
      id: "features",
      title: "Todo lo que puedes hacer",
      items: [
        { q: "¿Qué funciones tiene Chama?", a: { intro: "Aquí tienes toda la app en un recorrido rápido:", steps: [
          "Explora ofertas de tu comunidad o echa un vistazo a otro país y moneda.",
          "Crea una publicación de Intercambio, Tienda, Trabajo, Colecta, Ahorro o Pago comunitario de facturas, con precios, métodos de pago, menús y cantidades cuando correspondan.",
          "Únete a una publicación, chatea en privado con las demás personas del intercambio, financia la custodia de Bitcoin, sigue cada paso y vota para liberar o reembolsar.",
          "Reclama un cobro a M-Pesa donde esté disponible, cualquier dirección o factura Lightning, una billetera NWC conectada o una dirección Bitcoin on-chain.",
          "Usa el Panel para ver tu Chama, publicaciones activas, actividad como árbitro, bonos, ganancias y cualquier sat que te esté esperando.",
          "Usa Yo para ver qué necesita tu atención, fijar o posponer tareas, revisar el historial y las valoraciones, administrar tu perfil y cambiar los ajustes.",
          "Recibe recordatorios de uniones, bloqueos, mensajes, plazos, cobros y disputas; al tocar uno irás al intercambio que te necesita.",
          "Conviértete en árbitro de la comunidad, publica un bono reembolsable en Bitcoin, indica que estás disponible, resuelve disputas, construye reputación y gana la prima de seguro opcional.",
          "Usa Chama en inglés, francés o español en web, Android, macOS, Windows o Linux. Tu llave Nostr mantiene la misma identidad entre dispositivos.",
        ], outro: "Para ayuda paso a paso, abre la pregunta correspondiente más abajo. Los ajustes avanzados también permiten cambiar de comunidad, federación, firmante y nodo de Chama." } },
      ],
    },
    {
      id: "money",
      title: "Recibir tu dinero",
      items: [
        { q: "¿De dónde salen los sats para financiar un intercambio?", a: "Financias con Bitcoin (sats) que ya tienes — por ejemplo desde una billetera Lightning. Chama no te vende Bitcoin dentro de la app. En un intercambio típico, el lado del efectivo ocurre directamente entre tú y tu contraparte (les envías M-Pesa/Airtel como indica la publicación); Chama pone en custodia el lado de Bitcoin." },
        { q: "¿Cómo me pagan / retiro?", a: "Cuando un intercambio está listo, toca Reclamar y elige a dónde va tu dinero. Tus opciones dependen de tu país: 🇰🇪 Kenia — retira a M-Pesa con un toque (los KES llegan a tu celular en segundos). Otros países — se abre la página de un socio local donde exista (por ejemplo Banxaas en Senegal); vienen más. Lightning, en cualquier lugar — envía a cualquier dirección Lightning, factura o billetera conectada (NWC). Bitcoin on-chain — pega una dirección de Bitcoin (más lento; se aplican comisiones de red)." },
        { q: "¿Cómo retiro a M-Pesa (Kenia)?", a: { steps: [
          "En un intercambio completado, toca Reclamar.",
          "Elige Retirar a M-Pesa.",
          "Ingresa tu número de teléfono de M-Pesa (se guarda para la próxima vez).",
          "Confirma — verás el monto aproximado en KES, y los chelines llegan en segundos.",
        ], outro: "No hay app que instalar, ni cuenta, ni conocimiento de Bitcoin necesario. (Esto usa Tando, un puente Lightning → M-Pesa basado en estándares.)" } },
        { q: "¿Hay un límite para retirar por M-Pesa?", a: "Sí — los retiros por M-Pesa tienen un tope por transferencia. Si tu cobro supera el límite, Chama te muestra el máximo, para que envíes un monto menor o retires el resto por Lightning." },
        { q: "¿Puedo pagar un intercambio con M-Pesa (efectivo, no Bitcoin)?", a: "Hoy no dentro de la app. Retirar a dinero móvil funciona en los países compatibles; ingresar dinero (convertir tu dinero móvil en Bitcoin) es algo que haces de antemano con un servicio externo, o directamente con tu contraparte." },
      ],
    },
    {
      id: "safety",
      title: "Cuenta y seguridad",
      items: [
        { q: "¿Está seguro mi dinero?", a: "Hay riesgos. El ecash depende de que los guardianes de la federación indicada sigan disponibles y canjeen sus notas. La custodia directa en Bitcoin depende de su script y las condiciones de reembolso. Chama no tiene ninguno de los dos; lee quién los tiene y el plazo antes de aportar fondos." },
        { q: "Respalda tu cuenta (¡importante!)", a: "Tu llave es tu cuenta y tu vía de recuperación. Si pierdes tu teléfono sin un respaldo, podrías perder el acceso. Cuando inicies sesión, guarda tu llave / frase de recuperación en un lugar seguro y privado (anótala fuera de línea; nunca la compartas). Cualquiera con tu llave controla tu cuenta — trátala como efectivo." },
        { q: "¿Chama es privado?", a: "No le das a Chama un correo, número de teléfono ni identificación para usarlo. Tu identidad es solo tu llave. Ten en cuenta que lo que publicas en público (anuncios, chat en un intercambio) se comparte por la red Nostr." },
      ],
    },
    {
      id: "trouble",
      title: "Solución de problemas",
      items: [
        { q: "Dice “Conectando…” o me pide “Reconectar.”", a: "Chama habla con la red a través de relays. En una conexión débil algunos pueden caerse — toca Reconectar, o dale un momento; se reconecta solo. Tus intercambios y fondos nunca se pierden mientras esto pasa." },
        { q: "Terminé un intercambio pero dice que mi cobro “necesita atención.”", a: "Por lo general tu dinero ya llegó y la app solo no pudo confirmarlo automáticamente — revisa tu saldo o tu billetera. Chama guarda una copia de respaldo de la nota de todos modos, así que nada se pierde. Si de verdad falta, la nota guardada es tu vía de recuperación." },
        { q: "Falló la financiación o el cobro.", a: "Nada se mueve a menos que tenga éxito por completo — un intento fallido significa que no se enviaron sats. Espera un momento e intenta de nuevo; si una ruta sigue lenta, toca Reconectar primero. Si estás en una instalación nueva y una primera unión se queda colgada, asegúrate de tener una conexión estable y vuelve a intentarlo." },
      ],
    },
  ],
  glossary: [
    { term: "Sats", def: "La unidad pequeña de Bitcoin (1 Bitcoin = 100.000.000 sats). Los precios en Chama también se muestran en tu moneda local." },
    { term: "Lightning", def: "La red de pagos de Bitcoin rápida y barata que Chama usa para mover sats." },
    { term: "Custodia", def: "Una “retención” de los fondos durante un intercambio, liberada solo cuando las personas correctas están de acuerdo." },
    { term: "Árbitro", def: "Un miembro de la comunidad que puede cerrar un intercambio en disputa — nunca capaz de quedarse con tu dinero." },
    { term: "Llave / npub", def: "Tu cuenta en Chama (y Nostr). Respáldala." },
    { term: "M-Pesa / Tando", def: "Dinero móvil (Kenia) y el puente que convierte tus sats en efectivo M-Pesa." },
  ],
};
