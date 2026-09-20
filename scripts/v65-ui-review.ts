/** Render the changed components for a local, unsigned visual review. */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ListingBody } from '../src/ui/components/ListingBody.js';
import { ChamaBar } from '../src/ui/panels/ChamaBar.js';
import { ArbiterRecordCard } from '../src/ui/components/ArbiterRecordCard.js';
import { arbiterRecord } from '../src/arbiters/record.js';
const body = '**Bicycle repair**\n\nA full service with a written checklist.\n- Inspect brakes\n- Adjust gears\n[Workshop details](https://example.com/workshop)\n\n<script>alert("text only")</script>\n![tracking pixel](https://example.com/pixel.gif)';
const review = h('main',{},
  h(ChamaBar,{fedimint:{joined:true,lastHealthOk:true,federationName:'Local review'} as any,
    chamaLabel:{kind:'needs-you',count:2},onTapStranded(){},onTapInTrade(){},onInit(){},showReconnect:false}),
  h('section',{},h('h2',{},'Bicycle repair'), h(ListingBody,{body}),
    h(ArbiterRecordCard,{record:arbiterRecord('ab'.repeat(32),[],[],new Map(),1000)})));
const html = renderToStaticMarkup(review);
if (html.includes('<script>') || html.includes('<img')) throw new Error('Listing text generated active markup');
if (!html.includes('noopener noreferrer nofollow')) throw new Error('Link security attributes missing');
mkdirSync('/tmp/chama-v65-review',{recursive:true});
writeFileSync('/tmp/chama-v65-review/index.html',`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#080c11;color:#e2e8f0;font:15px system-ui;margin:0}main{max-width:600px;margin:24px auto}section{padding:20px}a{color:#8bbfff}summary{line-height:1.7}</style>${html}`);
console.log('/tmp/chama-v65-review/index.html');
