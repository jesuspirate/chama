// fr/recovery — Session B fills this from src/i18n/en/recovery.ts (key set must match EXACTLY).
export const recovery: Record<string, string> = {
  "recovery.barCheckingTrades": "Vérification de vos échanges…",
  "recovery.exportClearError": "Chama n’a pas pu terminer l’effacement de cet export. La copie de récupération reste conservée.",
  "recovery.exportClearing": "Finalisation sécurisée…",
  "recovery.exportStashFailedReabsorbed": "Chama n’a pas pu enregistrer la copie de récupération ecash, donc l’export a été annulé. Vos sats restent dans Chama (ou sont remboursés automatiquement après le délai). Libérez de l’espace et réessayez.",
  "recovery.aBalance": "un solde",
  "recovery.activeTradeMany": "{count} échanges actifs",
  "recovery.activeTradeOne": "1 échange actif",
  "recovery.barChooseChama": "Choisissez votre Chama",
  "recovery.barExternalRoute": "Route externe",
  "recovery.barInTradeAfter": "sous séquestre",
  "recovery.barInTradeBefore": "⚡ {trades} ·",
  "recovery.barReady": "Chama : prêt",
  "recovery.barReconnect": "Reconnecter",
  "recovery.barRecoverCta": "⚠ Récupérer",
  "recovery.barUnreachableCta": "⚠ Chama injoignable · Reconnecter →",
  "recovery.barUnreachableTitle":
    "Chama injoignable — les réceptions seront refusées",
  "recovery.bearerWarning":
    "L'ecash Fedimint est de l'argent au porteur — une fois votre Chama local effacé, ces sats ne peuvent pas être récupérés depuis cet appareil.",
  "recovery.cancelKeepChama": "Annuler — garder mon Chama",
  "recovery.exportClearConfirm":
    "Sûr ? Chama oubliera cette note — retapez seulement si elle est sauvegardée",
  "recovery.exportClearCta": "Je l'ai importée — effacer",
  "recovery.exportCopyCta": "Copier l'ecash",
  "recovery.exportQrAlt": "Code QR ecash animé pour Fedi",
  "recovery.exportQrHelp": "Dans Fedi, scannez jusqu'à la fin de la barre. Si Fedi rejoint ou restaure encore cette fédération, terminez d'abord cette étape (redémarrez Fedi si nécessaire), puis rouvrez cet export en attente et scannez à nouveau.",
  "recovery.exportErrorTitle": "Impossible de générer la note",
  "recovery.exportGenerateCta": "Générer une note ecash",
  "recovery.exportGenerateError":
    "Impossible de générer la note ecash. Vos sats sont en sécurité dans votre Chama.",
  "recovery.exportHeadline": "RETIRER EN ECASH · SANS FRAIS LN",
  "recovery.exportIntroAfter":
    "— sans frais Lightning. Parfait pour la poussière qui coûte plus cher à déplacer via Lightning qu'elle ne vaut.",
  "recovery.exportIntroBefore":
    "Transformez votre solde en note ecash Fedimint que vous pouvez importer dans Fedi — ou dans tout portefeuille Fedimint sur",
  "recovery.exportKeepPending": "La garder en attente — je finirai plus tard",
  "recovery.exportMinting": "CRÉATION DE VOTRE NOTE ECASH…",
  "recovery.exportReadyBody":
    "✓ Ecash Fedimint · {federation}. Importez ceci dans Fedi ou dans tout portefeuille Fedimint sur {federation}. Sauvegardez-la maintenant — c'est de l'argent au porteur.",
  "recovery.exportWarnAfter":
    "vos sats. Dès que vous la générez, votre solde quitte votre Chama et ne vit plus que dans cette chaîne de caractères. Sauvegardez-la avant de fermer — Chama en garde une copie sous « export ecash en attente » jusqu'à ce que vous confirmiez l'avoir importée. Elle ne fonctionne que sur {federation}, pas dans les portefeuilles Cashu.",
  "recovery.exportWarnBefore": "⚠ Cette note",
  "recovery.exportWarnIs": "est",
  "recovery.finishLockCta": "Finir le verrouillage →",
  "recovery.finishLockTag": "⏸ Finissez de verrouiller votre échange",
  "recovery.finishPayoutCta": "Finir le versement →",
  "recovery.finishPayoutTag": "⚡ Finissez votre versement",
  "recovery.finishing": "Finalisation…",
  "recovery.fundedTradeLabel": "ÉCHANGE FINANCÉ",
  "recovery.fundsAtRiskTag": "⚠ FONDS EN DANGER",
  "recovery.fundsReturnedBody1":
    "Un échange que vous avez financé ne s'est pas conclu, alors vos",
  "recovery.fundsReturnedBody2":
    "sont revenus dans le portefeuille Chama de cet appareil — en sécurité et à vous. Envoyez",
  "recovery.fundsReturnedBody3": "vers votre adresse Lightning",
  "recovery.fundsReturnedBody4": ", ou laissez-les simplement ici.",
  "recovery.fundsReturnedReserveAfter": "reste pour les frais)",
  "recovery.fundsReturnedReserveBefore": "(environ",
  "recovery.fundsReturnedTag": "↩ Fonds revenus",
  "recovery.guardNote":
    "Cette protection se base sur le solde de cet appareil, pas sur l'historique global de l'identité.",
  "recovery.headlineFundsReturned":
    "Votre financement est revenu sur cet appareil",
  "recovery.headlineLastTrade":
    "Votre dernier échange ne s'est pas terminé proprement",
  "recovery.headlineLeftoverSats":
    "Il vous reste des sats d'échanges précédents",
  "recovery.headlineTradeWith":
    "Votre échange avec {name} ne s'est pas terminé proprement",
  "recovery.keepUsingFooter":
    "Vous pouvez continuer à utiliser Chama. La récupération ne fait que sortir les sats inexpliqués d'OPFS.",
  "recovery.lockFooter":
    "La récupération est automatique et sans frais — rien n'est envoyé via Lightning.",
  "recovery.lockIntentAfter": "met vos sats sous séquestre.",
  "recovery.lockIntentBefore":
    "Vous étiez en train de financer cet échange quand l'app s'est fermée. Reprenez là où vous en étiez — verrouiller",
  "recovery.lockSpentAfter":
    "sont en sécurité — finissez le verrouillage pour les mettre sous séquestre.",
  "recovery.lockSpentBefore":
    "Votre dernière session s'est terminée avant la fin du verrouillage. Vos",
  "recovery.openTrade": "Ouvrir l'échange",
  "recovery.openTradeCta": "Ouvrir l'échange →",
  "recovery.payoutConfirmingAfter":
    "a été envoyé et se confirme. Chama vérifie automatiquement — ne réclamez pas à nouveau ; surveillez votre portefeuille de destination.",
  "recovery.payoutConfirmingBefore": "Votre versement de",
  "recovery.payoutConfirmingTag": "⏳ Versement en confirmation",
  "recovery.payoutFinishAfter":
    "sont dans votre portefeuille, mais le versement vers votre adresse n'a pas abouti. Ouvrez l'échange pour les envoyer où vous voulez.",
  "recovery.payoutFinishBefore": "Vous avez gagné cet échange — vos",
  "recovery.payoutFooter":
    "Réessayer est sans danger — Chama ne verse jamais deux fois le même échange.",
  "recovery.pendingLockNote":
    "Ces sats appartiennent à un échange que vous étiez en train de verrouiller sur ce Chama. Finissez ce verrouillage (ou laissez la récupération se terminer) avant de changer.",
  "recovery.recoverCta": "⚡ Récupérer",
  "recovery.recoverSwitchAfter": "et changer →",
  "recovery.recoverSwitchBefore": "⚡ Récupérer",
  "recovery.recoverableBalanceFallback": "votre solde récupérable",
  "recovery.reservedAfter": "sont réservés pour les frais Lightning.",
  "recovery.reservedBefore": "Environ",
  "recovery.roleArbiter": "Arbitre",
  "recovery.roleBuyer": "Acheteur",
  "recovery.roleSeller": "Vendeur",
  "recovery.satsLandFooter":
    "Les sats arrivent à votre adresse Lightning · Chama garde votre portefeuille local vide",
  "recovery.strandedBody1": "sont toujours dans le portefeuille Chama de cet appareil.",
  "recovery.strandedBody2":
    "peuvent être envoyés vers votre adresse Lightning maintenant",
  "recovery.strandedReserveAfter": "gardés pour les frais Lightning",
  "recovery.strandedReserveBefore": ", avec environ",
  "recovery.switchBody1": "Passer à",
  "recovery.switchBody2":
    "vous déplacera vers un autre Chama. Votre portefeuille local contient",
  "recovery.switchBody3": "sur ce Chama ;",
  "recovery.switchBody4":
    "peuvent d'abord être récupérés vers votre portefeuille Lightning.",
  "recovery.tradeLabel": "ÉCHANGE",
  "recovery.tradeNeedsAttention": "⚠ Échange : attention requise",
  "recovery.tryAgain": "Réessayer",
  "recovery.unknownCounterparty": "une contrepartie inconnue",
  "recovery.youFunded": "Vous avez financé",
  "recovery.yourRole": "Votre rôle :",
};
