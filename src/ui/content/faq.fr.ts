// French FAQ content — a full translation of faq.en.ts (same shape: same section
// ids, same q/step counts). Voice + terminology mirror docs/FAQ.fr.md and the
// app's locked FR glossary (src/i18n/fr/*).
import type { FaqContent } from "./faq-types.js";

export const faqFr: FaqContent = {
  intro:
    "Échangez des bitcoins, des biens et des services avec votre communauté. Un chama est un cercle d’épargne d’Afrique de l’Est ; ici, les échanges utilisent de l’ecash émis par une fédération ou un dépôt direct en Bitcoin. Chama ne détient pas l’argent ; le tableau ci-dessous indique qui le détient.",
  sections: [
    {
      id: "basics",
      title: "L'essentiel",
      items: [
        { q: "Qu'est-ce que Chama ?", a: "Une place de marché pair-à-pair pour le Bitcoin, les biens et les services de votre communauté. Les échanges utilisent soit de l’ecash émis par une fédération, soit un dépôt direct en Bitcoin. Le détenteur et les conditions de l’échange sont affichés avant le financement." },
        { q: "Dois-je connaître le Bitcoin ?", a: "Non. Vous choisissez votre pays et votre monnaie, vous échangez, et (dans les pays pris en charge) votre argent peut arriver directement sur votre compte d'argent mobile comme M-Pesa. Le Bitcoin, c'est la tuyauterie ; vous n'avez pas à y penser." },
        { q: "Chama est-il gratuit ? Quels sont les frais ?", a: "L'application est gratuite à télécharger, et Chama lui-même ne prend aucune commission — Chama ne détient pas votre argent ; l’ecash est garanti par du Bitcoin détenu par les gardiens d’une fédération. Sur un échange abouti, une petite prime d'assurance de 0,5 % va à l'arbitre communautaire qui garantit votre échange (0,25 % de chaque côté), envoyée en ecash. Elle est incluse par défaut et vous pouvez la désactiver avant de régler. Si un échange est confié à un arbitre pour trancher un litige, de petits frais supplémentaires s'appliquent pour ce travail. Les vendeurs peuvent aussi fixer leur propre prime sur une annonce (p. ex. « +25 % ») — c'est le prix du vendeur, pas un frais Chama — et vous voyez toujours le montant final avant de vous engager." },
        { q: "Est-ce que Chama détient mon argent ?", a: "Chama ne détient pas votre argent. L’ecash représente du Bitcoin détenu par les gardiens de la fédération indiquée, tant que vous gardez ses billets. Un dépôt direct en Bitcoin est détenu par le script de l’échange jusqu’au règlement ou au bloc de remboursement. Un solde ecash peut rester sur cet appareil entre deux échanges ; sauvegarder votre clé de compte ne sauvegarde pas ce solde." },
      ],
    },
    {
      id: "start",
      title: "Pour commencer",
      items: [
        { q: "Comment obtenir Chama ?", a: "Android : installez depuis Zapstore (zapstore.dev/apps/app.chama.market). Web & ordinateur : ouvrez getchama.app (aussi sur chama.community)." },
        { q: "Comment me connecter ?", a: "Chama utilise une clé comme compte (le standard Nostr) — pas d'e-mail/mot de passe et pas de formulaire d'inscription. L'application peut créer une clé pour vous, ou vous pouvez utiliser votre clé Nostr existante. Notez votre clé et gardez-la en lieu sûr — c'est elle, votre compte." },
        { q: "Qu'est-ce qu'une « communauté » et comment la choisir ?", a: "Une communauté, c'est votre monnaie + pays + drapeau — par exemple Kenya · KES, ou Sénégal · CFA. Vous choisissez la vôtre à la première connexion. Elle détermine la monnaie dans laquelle vos échanges sont libellés et les voisins avec qui vous échangez. Vous pouvez en changer plus tard dans Réglages → Avancé, mais vous restez « chez vous » par défaut. Vous pouvez aussi jeter un œil aux autres communautés en parcourant les annonces." },
      ],
    },
    {
      id: "trade",
      title: "Acheter & vendre",
      items: [
        { q: "Comment acheter ?", a: { steps: [
          "Dans Parcourir, touchez une annonce qui vous intéresse.",
          "Touchez Rejoindre comme acheteur pour réserver votre place (rien ne bouge encore).",
          "Composez votre commande / confirmez le montant, puis financez — vos sats sont alors verrouillés sous séquestre.",
          "Payez le vendeur en monnaie locale (p. ex. M-Pesa, Airtel) comme l'indique l'annonce, ou recevez vos biens.",
          "Quand vous avez reçu ce que vous avez payé, touchez pour libérer — les sats vont au vendeur. Terminé.",
        ] } },
        { q: "Comment vendre ?", a: { steps: [
          "Touchez Créer et publiez une annonce (Échange / Boutiques / Paiement communautaire de factures), fixez votre prix et les moyens de paiement que vous acceptez.",
          "Quand un acheteur rejoint et finance, les sats se verrouillent sous séquestre — vous verrez « Sats verrouillés sous séquestre ».",
          "Livrez le bien / envoyez la monnaie convenue, puis touchez Marquer comme livré (ou « Marquer comme envoyé ») — c'est votre confirmation.",
          "Une fois libéré, touchez Réclamer pour recevoir vos sats — et encaissez.",
        ] } },
        { q: "Quelles sont les étapes d'un échange ?", a: "Réservé (quelqu'un a rejoint) → Verrouillé (sats financés sous séquestre) → l'action se déroule (biens livrés / monnaie envoyée) → Libéré (les deux parties sont d'accord) → Réclamez votre versement → Réglé. Vous suivez tout sur la frise de l'échange, et pouvez discuter avec l'autre partie à tout moment." },
        { q: "En quoi le séquestre me protège-t-il ?", a: "Deux des trois participants doivent accepter le paiement : acheteur, vendeur et arbitre. Avec l’ecash, cela protège l’accès aux billets ; les gardiens de la fédération détiennent toujours le Bitcoin qui les garantit. Le dépôt direct en Bitcoin utilise un script avec une voie de remboursement pour le déposant. Ces règles n’éliminent pas les risques liés à la fédération ou à la perte de l’appareil." },
        { q: "Qu'est-ce qu'un arbitre ?", a: "Un membre de confiance de votre communauté qui peut aider à trancher un échange uniquement en cas de litige. Il ne peut pas prendre votre argent — il ne peut que départager acheteur et vendeur. Les arbitres bâtissent une réputation au fil du temps." },
        { q: "Et si quelque chose tourne mal / en cas de litige ?", a: "Si vous et votre interlocuteur n'êtes pas d'accord (p. ex. un bien jamais arrivé), chacun exprime son vote — libérer ou rembourser — en expliquant pourquoi. En cas de désaccord, l'arbitre est appelé pour décider équitablement. Vous n'êtes jamais laissé bloqué." },
        { q: "Comment annuler ou me rétracter ?", a: "Tant que rien n'est financé, vous pouvez simplement partir. Après le financement, se rétracter revient à voter un remboursement, qui renvoie les sats à la bonne personne (l'arbitre est le filet de sécurité). Chama vous montre toujours exactement où va l'argent avant de confirmer." },
      ],
    },
    {
      id: "features",
      title: "Tout ce que vous pouvez faire",
      items: [
        { q: "Quelles sont les fonctionnalités de Chama ?", a: { intro: "Voici toute l'application en un tour rapide :", steps: [
          "Parcourez les offres de votre communauté ou jetez un œil à un autre pays et une autre monnaie.",
          "Créez une annonce Échange, Boutique, Travail, Cagnotte, Épargne ou Paiement communautaire de factures, avec prix, moyens de paiement, menus et quantités selon le cas.",
          "Rejoignez une annonce, discutez en privé avec les autres participants, financez le séquestre Bitcoin, suivez chaque étape et votez pour libérer ou rembourser.",
          "Réclamez un versement vers M-Pesa là où il est pris en charge, toute adresse ou facture Lightning, un portefeuille NWC connecté, ou une adresse Bitcoin on-chain.",
          "Utilisez le Tableau de bord pour voir votre Chama, vos annonces actives, votre activité d'arbitre, vos cautions, vos gains et les sats qui vous attendent.",
          "Utilisez Moi pour voir ce qui requiert votre attention, épingler ou reporter une tâche, consulter l'historique et les évaluations, gérer votre profil et modifier les réglages.",
          "Recevez des rappels pour les arrivées, verrouillages, messages, échéances, réclamations et litiges ; touchez-en un pour ouvrir l'échange concerné.",
          "Devenez arbitre communautaire, déposez une caution Bitcoin remboursable, signalez votre disponibilité, tranchez les litiges, bâtissez votre réputation et gagnez la prime d'assurance facultative.",
          "Utilisez Chama en anglais, français ou espagnol sur le web, Android, macOS, Windows ou Linux. Votre clé Nostr conserve la même identité sur tous vos appareils.",
        ], outro: "Pour une aide pas à pas, ouvrez la question correspondante ci-dessous. Les réglages avancés permettent aussi de changer de communauté, de fédération, de signataire et de nœud Chama." } },
      ],
    },
    {
      id: "money",
      title: "Récupérer votre argent",
      items: [
        { q: "D'où viennent les sats pour financer un échange ?", a: "Vous financez avec des bitcoins (sats) que vous détenez déjà — par exemple depuis un portefeuille Lightning. Chama ne vous vend pas de bitcoins dans l'application. Dans un échange typique, le côté monnaie se passe directement entre vous et votre interlocuteur (vous lui envoyez M-Pesa/Airtel comme l'indique l'annonce) ; Chama met sous séquestre le côté Bitcoin." },
        { q: "Comment être payé / encaisser ?", a: "Quand un échange est prêt, touchez Réclamer et choisissez où va votre argent. Vos options dépendent de votre pays : 🇰🇪 Kenya — encaissez sur M-Pesa en un geste (les KES arrivent sur votre téléphone en quelques secondes). Autres pays — une page de partenaire local s'ouvre là où il en existe un (p. ex. Banxaas au Sénégal) ; d'autres arrivent. Lightning, partout — envoyez vers n'importe quelle adresse Lightning, facture, ou portefeuille connecté (NWC). Bitcoin on-chain — collez une adresse Bitcoin (plus lent ; frais de réseau)." },
        { q: "Comment encaisser sur M-Pesa (Kenya) ?", a: { steps: [
          "Sur un échange abouti, touchez Réclamer.",
          "Choisissez Encaisser sur M-Pesa.",
          "Saisissez votre numéro M-Pesa (il est enregistré pour la prochaine fois).",
          "Confirmez — vous verrez le montant approximatif en KES, et les shillings arrivent en quelques secondes.",
        ], outro: "Aucune application à installer, aucun compte, aucune connaissance du Bitcoin requise. (Cela utilise Tando, un pont Lightning → M-Pesa basé sur des standards.)" } },
        { q: "Y a-t-il une limite pour l'encaissement M-Pesa ?", a: "Oui — les encaissements M-Pesa sont plafonnés par transfert. Si votre réclamation dépasse la limite, Chama vous montre le maximum, pour que vous puissiez envoyer un montant plus petit ou encaisser le reste via Lightning." },
        { q: "Puis-je payer un échange en M-Pesa (en espèces, pas en Bitcoin) ?", a: "Pas dans l'application pour l'instant. Encaisser vers l'argent mobile fonctionne dans les pays pris en charge ; convertir votre argent mobile en Bitcoin est quelque chose que vous faites au préalable avec un service externe, ou directement avec votre partenaire d'échange." },
      ],
    },
    {
      id: "safety",
      title: "Votre compte & sécurité",
      items: [
        { q: "Mon argent est-il en sécurité ?", a: "Il existe des risques. L’ecash dépend de la disponibilité des gardiens de la fédération indiquée et du remboursement de ses billets. Le dépôt direct en Bitcoin dépend de son script et des conditions de remboursement. Chama ne détient ni l’un ni l’autre ; lisez le détenteur et l’échéance avant d’engager vos fonds." },
        { q: "Sauvegardez votre compte (important !)", a: "Votre clé est votre compte et votre seul moyen de récupération. Si vous perdez votre téléphone sans sauvegarde, vous pourriez perdre l'accès. À la connexion, enregistrez votre clé / phrase de récupération en lieu sûr et privé (notez-la hors ligne ; ne la partagez jamais). Quiconque détient votre clé contrôle votre compte — traitez-la comme de l'argent liquide." },
        { q: "Chama respecte-t-il ma vie privée ?", a: "Vous ne donnez à Chama ni e-mail, ni numéro de téléphone, ni pièce d'identité pour l'utiliser. Votre identité, c'est juste votre clé. Gardez à l'esprit que ce que vous publiez publiquement (annonces, messages d'un échange) circule sur le réseau Nostr." },
      ],
    },
    {
      id: "trouble",
      title: "Dépannage",
      items: [
        { q: "Il affiche « Connexion… » ou demande de « Reconnecter ».", a: "Chama communique avec le réseau via des relais. Sur une connexion faible, quelques-uns peuvent tomber — touchez Reconnecter, ou patientez un instant ; il se reconnecte tout seul. Vos échanges et vos fonds ne sont jamais perdus pendant ce temps." },
        { q: "J'ai terminé un échange mais il dit que ma réclamation « nécessite votre attention ».", a: "En général, votre argent est déjà arrivé et l'application n'a simplement pas pu le confirmer automatiquement — vérifiez votre solde ou votre portefeuille. Chama garde une copie de secours de la note dans tous les cas, donc rien n'est perdu. S'il manque réellement, la note enregistrée est votre voie de récupération." },
        { q: "Le financement ou la réclamation a échoué.", a: "Rien ne bouge sans réussite complète — une tentative échouée signifie qu'aucun sat n'a été envoyé. Patientez un instant puis réessayez ; si une voie reste lente, touchez d'abord Reconnecter. Si vous êtes sur une toute nouvelle installation et qu'une première connexion bloque, assurez-vous d'avoir une connexion stable et réessayez." },
      ],
    },
  ],
  glossary: [
    { term: "Sats", def: "La petite unité du Bitcoin (1 Bitcoin = 100 000 000 sats). Les prix dans Chama s'affichent aussi dans votre monnaie locale." },
    { term: "Lightning", def: "Le réseau de paiement Bitcoin rapide et bon marché que Chama utilise pour déplacer les sats." },
    { term: "Séquestre", def: "Une « consignation » des fonds pendant un échange, libérée seulement quand les bonnes personnes sont d'accord." },
    { term: "Arbitre", def: "Un membre de la communauté qui peut trancher un échange en litige — sans jamais pouvoir prendre votre argent." },
    { term: "Clé / npub", def: "Votre compte sur Chama (et Nostr). Sauvegardez-la." },
    { term: "M-Pesa / Tando", def: "L'argent mobile (Kenya) et le pont qui transforme vos sats en espèces M-Pesa." },
  ],
};
