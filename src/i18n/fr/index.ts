// FR dictionary — per-namespace files (mirrors en/) so translation agents
// fan out with zero file contention. Missing keys fall back to en, then the key.
import { app } from "./app.js";
import { bond } from "./bond.js";
import { browse } from "./browse.js";
import { card } from "./card.js";
import { chat } from "./chat.js";
import { claim } from "./claim.js";
import { common } from "./common.js";
import { connect } from "./connect.js";
import { create } from "./create.js";
import { fund } from "./fund.js";
import { guided } from "./guided.js";
import { help } from "./help.js";
import { labels } from "./labels.js";
import { me } from "./me.js";
import { nav } from "./nav.js";
import { notify } from "./notify.js";
import { onchain } from "./onchain.js";
import { picker } from "./picker.js";
import { recovery } from "./recovery.js";
import { trade } from "./trade.js";
import { tranche } from "./tranche.js";
import { work } from "./work.js";

export const fr: Record<string, string> = {
  ...app,
  ...bond,
  ...browse,
  ...card,
  ...chat,
  ...claim,
  ...common,
  ...connect,
  ...create,
  ...fund,
  ...guided,
  ...help,
  ...labels,
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
