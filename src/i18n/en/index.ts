// English — the source of truth. One namespace file per screen-group so the
// extraction sweep (and later the fr/es translation passes) fan out with zero
// file contention. Every key is dot-prefixed with its namespace.
import { app } from "./app.js";
import { bond } from "./bond.js";
import { browse } from "./browse.js";
import { card } from "./card.js";
import { canvas } from "./canvas.js";
import { chat } from "./chat.js";
import { claim } from "./claim.js";
import { common } from "./common.js";
import { connect } from "./connect.js";
import { create } from "./create.js";
import { dash } from "./dash.js";
import { fund } from "./fund.js";
import { guided } from "./guided.js";
import { help } from "./help.js";
import { labels } from "./labels.js";
import { lts } from "./lts.js";
import { me } from "./me.js";
import { nav } from "./nav.js";
import { notify } from "./notify.js";
import { onchain } from "./onchain.js";
import { picker } from "./picker.js";
import { recovery } from "./recovery.js";
import { trade } from "./trade.js";
import { tranche } from "./tranche.js";
import { work } from "./work.js";

export const en: Record<string, string> = {
  ...app,
  ...bond,
  ...browse,
  ...card,
  ...canvas,
  ...chat,
  ...claim,
  ...common,
  ...connect,
  ...create,
  ...dash,
  ...fund,
  ...guided,
  ...help,
  ...labels,
  ...lts,
  ...me,
  ...nav,
  ...onchain,
  ...notify,
  ...picker,
  ...recovery,
  ...trade,
  ...tranche,
  ...work,
};
