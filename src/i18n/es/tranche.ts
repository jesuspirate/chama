// es/tranche — tranching: a split trade, and the stop that makes it worth splitting.
export const tranche: Record<string, string> = {
  "tranche.title": "Tramo {done} de {total} liquidado",
  "tranche.outstanding": "aún por venir",
  "tranche.readyBody": "El último tramo llegó. Iniciar el siguiente pone en juego como máximo {max} sats — nunca todo el intercambio.",
  "tranche.liveBody": "Este tramo sigue en curso. El siguiente se abre cuando se liquide y los sats te lleguen.",
  "tranche.completeBody": "Todos los tramos se liquidaron. Este intercambio terminó.",
  "tranche.stoppedBody": "Este tramo terminó en la cadena pero los sats no te llegaron. Detente aquí — no envíes ni despaches nada más. Revisa tu billetera y este intercambio antes de seguir con esta contraparte.",
  "tranche.startNext": "Iniciar tramo {n}",
  "tranche.starting": "Iniciando…",
  "tranche.splitLabel": "DIVIDIR ESTE INTERCAMBIO",
  "tranche.splitHint": "Divide un intercambio grande en tramos que se liquidan de a uno. Si algo sale mal pierdes un tramo, no todo.",
  "tranche.splitOff": "No dividir",
  "tranche.splitN": "{n} tramos",
  "tranche.splitRisk": "Lo máximo que puedes perder de una vez: {max} sats",
  "tranche.startFailed": "No se pudo iniciar el siguiente tramo.",
  "tranche.startedToast": "Siguiente tramo publicado.",
};
