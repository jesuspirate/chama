// es/claim — Session C fills this from src/i18n/en/claim.ts (key set must match EXACTLY).
export const claim: Record<string, string> = {
  "claim.ecashMethod": "Ecash · sin comisiones",
  "claim.ecashMethodBlurb": "Cobra como nota al portador lista para Fedi. Chama guarda una copia de recuperación hasta que confirmes la importación.",
  "claim.ecashReadyHeadline": "COBRO LISTO · IMPORTAR ECASH",
  "claim.ecashReadyBody": "Escanea con Fedi y confirma solo cuando Fedi muestre los sats. Chama mantiene recuperable esta nota exacta hasta que lo apruebes.",
  "claim.phaseExportingEcash": "Protegiendo tu nota ecash…",
  "claim.yourFederation": "tu federación",
  "claim.add": "Agregar",
  "claim.added": "Agregado",
  "claim.badgeCash": "efectivo",
  "claim.badgeComingSoon": "muy pronto",
  "claim.badgeLive": "activo",
  "claim.badgeLiveNow": "activo ahora",
  "claim.badgeNative": "nativo",
  "claim.badgeNew": "nuevo",
  "claim.badgeSoon": "pronto",
  "claim.badgeTopPick": "recomendado",
  "claim.banksAndApps": "Bancos y apps",
  "claim.banksAndAppsBody":
    "Tarjetas, PayPal, Zelle, transferencia bancaria, UPI, Pix — mayormente occidentales.",
  "claim.bestPathLn":
    "Mejor ruta. Envía a una dirección Lightning, factura o NWC.",
  "claim.cashOutMpesa": "Cobrar en M-Pesa",
  "claim.cashOutStrike": "Cobrar · Strike",
  "claim.chapsmartBody":
    "Ingresa tu número de M-Pesa. Chama lo paga directo desde tu cobro y ChapSmart deposita TZS en segundos — sin redirección, sin pegar facturas.",
  "claim.chapsmartCardBlurb":
    "Cobra en M-Pesa con ChapSmart. Ingresa tu teléfono — los TZS llegan en segundos.",
  "claim.chapsmartKicker": "COBRO M-PESA · CHAPSMART",
  "claim.checkProvider": "Revisar {provider}",
  "claim.checkingChama": "Revisando tu Chama…",
  "claim.chooseWhere":
    "Elige a dónde envía Chama el ecash reconstruido cuando se liquide tu cobro.",
  "claim.claimArrow": "RECLAMAR →",
  "claim.claimKicker": "COBRO",
  "claim.claimOnchain": "Reclamar en cadena",
  "claim.claimViaProviderInvoice": "Reclamar con factura de {provider}",
  "claim.claimYourSats": "Reclama tus sats",
  "claim.closeCheckLater": "Cerrar y revisar luego",
  "claim.closing": "Cerrando…",
  "claim.confirmCashReceive": "Confirmar recepción como Efectivo",
  "claim.defaultBadge": "PREDETERMINADO",
  "claim.defaultForMobileMoney": "Predeterminado para dinero móvil",
  "claim.delete": "Eliminar",
  "claim.edit": "Editar",
  "claim.errChapsmartAmountRange":
    "Este monto está fuera de los límites de M-Pesa de ChapSmart. {message}",
  "claim.errChapsmartDns":
    "No pudimos conectar con ChapSmart (chapsmart.com). Revisa tu conexión e inténtalo de nuevo.",
  "claim.errChapsmartFallback": "No pudimos conectar con ChapSmart. Inténtalo de nuevo.",
  "claim.errChapsmartMalformed":
    "ChapSmart devolvió una respuesta inesperada. Inténtalo de nuevo o usa Lightning.",
  "claim.errChapsmartServer":
    "El servidor de ChapSmart está ocupado ahora mismo. Inténtalo en un momento.",
  "claim.errChooseMethodAndId": "Elige un método de pago e ingresa el ID de pago",
  "claim.errChooseSavedOrEnter": "Elige una dirección guardada o ingresa un destino",
  "claim.errConfirmCashReceive":
    "Confirma que Strike está configurado para recibir Lightning pasivo como Efectivo.",
  "claim.errClaimCouldNotStart":
    "No se pudo iniciar el cobro. Reconecta tu Chama e inténtalo de nuevo.",
  "claim.errDestinationMustBeText": "El destino debe ser texto",
  "claim.errEnterDestination":
    "Ingresa una dirección Lightning (tu@billetera.app) o pega una factura BOLT11 o conexión NWC",
  "claim.errEnterPhone": "Ingresa un número de teléfono",
  "claim.errEnterValidKenyanNumber":
    "Ingresa un número M-Pesa keniano válido, p. ej. 0712 345 678.",
  "claim.errEnterValidTanzanianNumber":
    "Ingresa un número M-Pesa Vodacom tanzano válido, p. ej. 0740 034 110.",
  "claim.errFederationUnreachable": "La federación sigue inalcanzable",
  "claim.errMpesaAddressInvalid":
    "Ese número no resolvió a una dirección de cobro M-Pesa válida.",
  "claim.errNwcNoInvoice": "La billetera NWC no pudo crear una factura de destino",
  "claim.errNwcRefused": "La billetera NWC rechazó la solicitud de factura. {message}",
  "claim.errNwcRelayUnreachable": "No pudimos conectar con ese relay NWC. {message}",
  "claim.errNwcUnexpected":
    "La billetera NWC devolvió una respuesta inesperada. {message}",
  "claim.errRawLnurl":
    "Aquí no se admite LNURL en crudo. Usa una dirección Lightning, factura BOLT11 o conexión NWC.",
  "claim.errResolveDestination": "No se pudo resolver el destino",
  "claim.errSaveMethodFailed": "No se pudo guardar el método de pago",
  "claim.errSavePhoneFailed": "No se pudo guardar el número de teléfono",
  "claim.errTandoAmountRange":
    "Este monto está fuera de los límites de M-Pesa de Tando. {message}",
  "claim.errTandoDns":
    "No pudimos conectar con Tando (bitcoin.co.ke). Revisa tu conexión e inténtalo de nuevo.",
  "claim.errTandoFallback": "No pudimos conectar con Tando. Inténtalo de nuevo.",
  "claim.errTandoMalformed":
    "Tando devolvió una respuesta inesperada. Inténtalo de nuevo o usa Lightning.",
  "claim.errTandoServer": "El servidor de Tando está ocupado ahora mismo. Inténtalo en un momento.",
  "claim.errWalletServerUnhappy": "El servidor de esa billetera tiene problemas. {message}",
  "claim.errWalletServerUnreachable":
    "No pudimos conectar con el servidor de esa billetera. {message}",
  "claim.errWalletUnexpected":
    "Esa billetera devolvió una respuesta inesperada. {message}",
  "claim.errStrikeAmountRange":
    "Este monto está fuera de los límites de recepción de Strike. {message}",
  "claim.errStrikeDns":
    "No pudimos conectar con Strike (strike.me). Revisa tu conexión e inténtalo de nuevo.",
  "claim.errStrikeFallback": "No pudimos conectar con Strike. Inténtalo de nuevo.",
  "claim.errStrikeMalformed":
    "Strike devolvió una respuesta inesperada. Inténtalo de nuevo o usa Lightning.",
  "claim.errStrikeParse":
    "Ese nombre de usuario no resolvió a una dirección Strike válida.",
  "claim.errStrikeServer": "El servidor de Strike está ocupado ahora mismo. Inténtalo en un momento.",
  "claim.errEnterStrikeUsername": "Ingresa tu nombre de usuario de Strike, p. ej. alice.",
  "claim.externalBlurbFallback":
    "Abre {provider} — cobra en {currency}, pega la factura de vuelta.",
  "claim.externalLiveBodyAfter": ", luego pégala de vuelta abajo.",
  "claim.externalLiveBodyBefore":
    "Abre {provider} en tu navegador — cobra en dinero móvil {currency} ahí, crea una factura de hasta",
  "claim.externalSoonBody":
    "{provider} lista este país como muy pronto. Usa Lightning o en cadena para este cobro por hoy.",
  "claim.fastestNwcHeading": "⚡ MÁS RÁPIDO · RECLAMAR DIRECTO A BILLETERA NWC GUARDADA",
  "claim.feeReserveAfter": "queda disponible para comisiones de Lightning.",
  "claim.feeReserveBefore": "Alrededor de",
  "claim.insuranceBefore": "🛡",
  "claim.insuranceAfter": "queda apartado para el seguro de tu árbitro (0,25 %).",
  "claim.ifCashReceiveOn": "si la recepción como Efectivo está activada",
  "claim.invoiceOnlyHint": "Para billeteras solo de factura o make_invoice de NWC.",
  "claim.kenyanNumbersHint":
    "Los números móviles kenianos se ven como 0712 345 678 o 254712345678.",
  "claim.lightningAddresses": "Direcciones Lightning",
  "claim.lightningAddressesBody":
    "Direcciones Lightning guardadas para cobros y recuperación. Se quedan locales en este navegador y nunca se muestran a la contraparte de un intercambio.",
  "claim.lnFast": "LN · RÁPIDO",
  "claim.longRunningEscape":
    "Está tardando más de lo esperado. Tu cobro está publicado, pero el abono en la billetera aún no está confirmado — cierra y vuelve a revisar, o deja que Chama siga comprobándolo en segundo plano.",
  "claim.mask": "Ocultar",
  "claim.methodOnchainSlow": "EN CADENA · LENTO",
  "claim.moreOptionsClosed": "▸ Más opciones",
  "claim.moreOptionsOpen": "▾ Más opciones",
  "claim.mpesaPhoneLabel": "NÚMERO DE TELÉFONO M-PESA",
  "claim.networkTags": "Etiquetas de red",
  "claim.noLightningAddresses":
    "Aún no hay direcciones Lightning guardadas. Usa Reclamar o Recuperar y elige recordar.",
  "claim.noMatchYet": "Sin coincidencias aún. Prueba un país, nombre de app o «banco».",
  "claim.noSavedMethods":
    "Aún no hay métodos de pago guardados. Agrega un número de teléfono o busca una app de pago arriba.",
  "claim.noTagsYet": "Aún sin etiquetas",
  "claim.nwcInvoiceBefore": "Factura NWC ·",
  "claim.openArrow": "ABRIR →",
  "claim.onchainBlurb": "Pega una dirección de bitcoin una vez. Las comisiones se descuentan del pago.",
  "claim.onchainClaimKicker": "COBRO EN CADENA",
  "claim.onchainSlowPath":
    "Ruta lenta. Pega una dirección de bitcoin nueva. Chama la usa solo para esta transacción y no la guarda. Las comisiones de red y de peg-out salen del monto reclamado.",
  "claim.oneTap": "un toque",
  "claim.openProviderSwap": "Abrir swap de {provider}",
  "claim.optionalNetworkTags": "Etiquetas de red opcionales",
  "claim.orSendNewAddress": "O ENVÍA A UNA NUEVA DIRECCIÓN",
  "claim.pasteBolt11OrNwc": "PEGA FACTURA BOLT11 O NWC",
  "claim.payInvoiceBefore": "Pagar factura ·",
  "claim.payingBefore": "Pagando",
  "claim.paymentIdFallback": "ID de pago",
  "claim.paymentIdFor": "ID de pago para {rail}",
  "claim.paymentMethods": "Métodos de pago",
  "claim.paymentMethodsBody":
    "Guarda las formas en que la gente puede pagarte localmente. Los números de teléfono se mantienen privados; los nombres de usuario públicos pueden mostrarse en el perfil uno por uno si lo eliges.",
  "claim.payoutConfirmingBody":
    "Tu pago fue enviado y se está confirmando. No toques Reclamar de nuevo — revisa tu billetera de destino.",
  "claim.payoutFailedPlain": "{error}\n\nTus sats están a salvo en tu Chama.",
  "claim.payoutFailedRetryClaim":
    "{error}\n\nTus sats están a salvo en tu Chama. Cierra esto y toca Reclamar de nuevo — el pago se reintenta con una factura nueva.",
  "claim.payoutFailedShowRecovery":
    "{error}\n\nTus sats están a salvo en tu Chama. Toca Mostrar recuperación ahora para reintentar solo el pago.",
  "claim.phaseClaiming": "Recuperando tu parte…",
  "claim.phaseConfirming": "Confirmando con la federación…",
  "claim.phasePayingOnchain": "Transmitiendo pago en cadena…",
  "claim.phasePayoutConfirming": "Confirmando tu pago…",
  "claim.phaseSendingMpesaChapsmart": "Enviando a M-Pesa (ChapSmart)…",
  "claim.phaseSendingMpesaTando": "Enviando a M-Pesa (Tando)…",
  "claim.phaseSendingProvider": "Enviando a {provider}…",
  "claim.phaseSendingWallet": "Enviando a tu billetera…",
  "claim.phaseWorking": "Trabajando…",
  "claim.phoneNumber": "Número de teléfono",
  "claim.phoneProgressHint": "{country}: {expected} después de +{code}",
  "claim.privacyPrivate": "Privado",
  "claim.privacyPublicOptIn": "Público opcional",
  "claim.privateBadge": "PRIVADO",
  "claim.providerClaimKicker": "COBRO {provider}",
  "claim.publicBadge": "PÚBLICO",
  "claim.reachingChapsmart": "Conectando con ChapSmart…",
  "claim.reachingTando": "Conectando con Tando…",
  "claim.recoveredToWallet": "Recuperado a tu billetera",
  "claim.recoveryConfirmingBody":
    "Tu pago fue enviado y se está confirmando. No reintentes — revisa tu billetera de destino.",
  "claim.recoveryCouldntBeSent": "No se pudo enviar la recuperación",
  "claim.recoverySatsStillSafe":
    "Tus sats siguen en tu Chama. Inténtalo de nuevo con una factura nueva.",
  "claim.rememberNwcWallet": "Recordar esta billetera NWC",
  "claim.resolving": "Resolviendo…",
  "claim.reveal": "Mostrar",
  "claim.safaricomKenya": "Safaricom M-Pesa, Kenia.",
  "claim.saveAndSendBefore": "Guardar y enviar ·",
  "claim.saveMethod": "Guardar método",
  "claim.savePhone": "Guardar teléfono",
  "claim.savedAddresses": "DIRECCIONES GUARDADAS",
  "claim.savedDestinations": "DESTINOS GUARDADOS",
  "claim.savedMethods": "Métodos guardados",
  "claim.savedNwcWallets": "BILLETERAS NWC GUARDADAS",
  "claim.savedStrike": "🇺🇸 STRIKE GUARDADO",
  "claim.searchBanksPlaceholder": "Busca PayPal, UPI, Pix, transferencia bancaria...",
  "claim.searchNetworks": "Buscar redes",
  "claim.searchNetworksForPhone": "Buscar redes para este teléfono",
  "claim.selectedCount": "{count} seleccionados",
  "claim.sendOnceDontSave": "Enviar una vez — no guardar",
  "claim.sendToAddressAfter": "a tu dirección Lightning",
  "claim.sendToAddressBefore": "Enviar",
  "claim.sendToLightningAddress": "ENVIAR A DIRECCIÓN LIGHTNING",
  "claim.sendToWalletAfter": "a tu billetera Lightning",
  "claim.sendToWalletBefore": "Enviar",
  "claim.sendingToWalletCaps": "ENVIANDO A TU BILLETERA…",
  "claim.sentToMpesa": "Enviado a M-Pesa",
  "claim.sentToProvider": "Enviado a {provider}",
  "claim.sentToStrike": "Enviado a Strike",
  "claim.sentToWallet": "Enviado a tu billetera",
  "claim.showRecoveryNow": "Mostrar recuperación ahora",
  "claim.strikeBodyAfter":
    ". Chama solicita una factura Strike nueva y la paga desde este cobro — sin redirección, sin pegar facturas.",
  "claim.strikeBodyBefore": "Ingresa el nombre antes de",
  "claim.strikeCardBlurb":
    "Ingresa tu nombre de usuario de Strike — agregamos @strike.me y enviamos.",
  "claim.strikeCashCheckbox":
    "Strike está configurado para recibir pagos Lightning pasivos como Efectivo.",
  "claim.strikeCashTitle": "Haz que llegue como dólares",
  "claim.strikeSendsSats":
    "Chama envía sats; Strike aplica la conversión final y cualquier spread al recibir.",
  "claim.strikeUseDifferent": "Usa un nombre de usuario de Strike diferente.",
  "claim.strikeEstimate": "≈ {estimate} tras la conversión de Strike, si la recepción como Efectivo está activada.",
  "claim.strikeHandleHint": "Usa solo el nombre de usuario de Strike — agregamos @strike.me.",
  "claim.strikeKicker": "STRIKE · USD",
  "claim.strikeTitle": "Cobra a través de Strike",
  "claim.strikeUsernameLabel": "NOMBRE DE USUARIO DE STRIKE",
  "claim.strikeUsernameOnly": "Ingresa solo el nombre de usuario — agregamos @strike.me.",
  "claim.submitSendBefore": "Enviar",
  "claim.phaseSendingStrike": "Enviando a Strike (USD)…",
  "claim.reachingStrike": "Conectando con Strike…",
  "claim.sendToStrike": "Enviar a Strike",
  "claim.tandoBody":
    "Ingresa tu número de M-Pesa. Chama lo paga directo desde tu cobro y Tando deposita KES en segundos — sin redirección, sin pegar facturas.",
  "claim.tandoCardBlurb":
    "Cobra en M-Pesa con Tando. Ingresa tu teléfono — los KES llegan en segundos.",
  "claim.tandoKicker": "COBRO M-PESA · TANDO",
  "claim.tanzanianNumbersHint":
    "Los números Vodacom tanzanos se ven como 0740 034 110 o 255740034110.",
  "claim.railPlaceholderSpei": "CLABE / celular / alias bancario",
  "claim.railPlaceholderBank": "Número de cuenta / IBAN",
  "claim.swapBlurbBanxaas": "Retira a dinero móvil XOF vía Banxaas.",
  "claim.tapToMask": "Toca para ocultar",
  "claim.tapToReveal": "Toca para mostrar",
  "claim.titleClaimDidNotSettle": "El cobro no se liquidó",
  "claim.titleCouldntReachChama": "No pudimos conectar con tu Chama",
  "claim.titleCouldntRecoverShare": "No pudimos recuperar tu parte",
  "claim.titlePayoutCouldntBeSent": "No se pudo enviar el pago",
  "claim.titlePayoutSentConfirming": "Pago enviado — confirmando",
  "claim.titleSatsStillArriving": "Tus sats aún están llegando",
  "claim.tryAgain": "Inténtalo de nuevo",
  "claim.tryAmountBefore": "Prueba",
  "claim.vodacomTanzania": "Vodacom M-Pesa, Tanzania.",
  "claim.worksForWallets":
    "Funciona para M-Pesa, Wave, Airtel Money, Orange Money, transferencias bancarias móviles y la mayoría de billeteras basadas en teléfono.",
  "claim.youllReceiveMpesa": "Recibirás ≈ {estimate} en M-Pesa.",
  "claim.yourPaymentId": "Tu ID de pago",
};
