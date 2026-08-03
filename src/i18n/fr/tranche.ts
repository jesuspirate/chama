// fr/tranche — tranching: a split trade, and the stop that makes it worth splitting.
export const tranche: Record<string, string> = {
  "tranche.title": "Tranche {done} sur {total} réglée",
  "tranche.outstanding": "reste à venir",
  "tranche.readyBody": "La dernière tranche est arrivée. Lancer la suivante met au plus {max} sats en jeu — jamais tout l'échange.",
  "tranche.liveBody": "Cette tranche est en cours. La suivante s'ouvre une fois qu'elle est réglée et que les sats vous parviennent.",
  "tranche.completeBody": "Toutes les tranches sont réglées. Cet échange est terminé.",
  "tranche.stoppedBody": "Cette tranche est terminée sur la chaîne mais les sats ne vous sont pas parvenus. Arrêtez ici — n'envoyez et n'expédiez rien d'autre. Vérifiez votre portefeuille et cet échange avant d'aller plus loin avec cette contrepartie.",
  "tranche.startNext": "Lancer la tranche {n}",
  "tranche.starting": "Lancement…",
  "tranche.splitLabel": "DÉCOUPER CET ÉCHANGE",
  "tranche.splitHint": "Découpez un gros échange en tranches réglées une par une. Si quelque chose tourne mal, vous perdez une tranche, pas le tout.",
  "tranche.splitOff": "Ne pas découper",
  "tranche.splitN": "{n} tranches",
  "tranche.splitRisk": "Perte maximale d'un coup : {max} sats",
  "tranche.startFailed": "Impossible de lancer la tranche suivante.",
  "tranche.startedToast": "Tranche suivante publiée.",
};
