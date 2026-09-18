import {writeWorkspacePreference} from './workspace-preference-write.js';
import {renderTemplateSettings} from './project-template-settings.js';
/* Reference settings and directory surfaces for the native AbdoCode shell.
   Existing controls remain in their original panels so their save contract and IDs stay intact. */

import {languageChoices} from './language-catalogue.js';

const $ = id => document.getElementById(id);
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ICONS = {
  general:'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  account:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9c.6-4 3-6 7-6s6.4 2 7 6',
  privacy:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm0 7v5',
  billing:'M3 7h18v12H3zM3 11h18m-14 4h4', usage:'M4 20V10m6 10V4m6 16v-7m5 7V7',
  capabilities:'M4 7h16v12H4zM9 7V5h6v2m-7 5h8', code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-17-2 22',
  cowork:'M4 18v-1c0-3 2-5 5-5s5 2 5 5v1m-5-7a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6 1c3 0 5 2 5 5v1',
  chrome:'M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 0 5 9m-14 0h9m-4 8 4-8',
  // أيقونةُ اللغة (09-14): كانت تستعير رمزَ كروم؛ رمزُ ترجمة «A / ع»: حرفٌ لاتينيّ يساراً وقوسُ حرفٍ عربيّ يميناً
  language:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-9 9h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  desktop:'M3 4h18v13H3zm6 17h6m-3-4v4', extensions:'M8 3v5H3v5h5v5h5v-5h5V8h-5V3z',
  developer:'M14 4a6 6 0 0 0-7 8l-5 5v4h4l6-6a6 6 0 0 0 8-7l-4 4-4-4z',
  remote:'M7 3h10v18H7zm4 15h2M12 6v.01m-4 5 4-4 4 4',
  skills:'M12 3v18M3 12h18M5.5 5.5l13 13m0-13-13 13', super:'M12 3v18M3 12h18M5.5 5.5l13 13m0-13-13 13', providers:'M4 6h16M4 12h16M4 18h16', connectors:'M8 7V3m8 4V3M6 7h12v4a6 6 0 0 1-12 0z',
  plugins:'M8 3v5H3v5h5v5h5v-5h5V8h-5V3z', memory:'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8m-8 4h8m-8 4h5',
  api:'M14 6a4 4 0 1 1-4-4 4 4 0 0 1 4 4L3 17v4h4l2-2 2 2 3-3-2-2 2-2',
  permissions:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3', keys:'M14 8a4 4 0 1 1-4-4 4 4 0 0 1 4 4L3 19v2h3l2-2 2 2 3-3-2-2 3-3',
  models:'M4 6h16M4 12h16M4 18h16', runtime:'M5 12h3l2-5 4 10 2-5h3', layout:'M3 4h18v16H3zm7 0v16m0-8h11'
};
// أيقوناتُ المالك (2026-09-06) — مسارٌ مملوء بلون النصّ، عرضُ الرسم 12.5؛ ما ليس هنا يبقى على الرسم الخطّيّ أعلاه.
const ICON_MARKUP = {
  general: '<path d="M6.4,11.4h-.5c-.6,0-1-.5-1-1.1s0-.3-.2-.3-.3,0-.4,0c-.4.4-1,.4-1.5,0l-.5-.5c-.4-.4-.3-1.1,0-1.5s.2-.2.1-.4-.2-.3-.3-.3c-.6,0-1-.4-1.1-.9s0-.4,0-.6c0-.6.5-1.2,1.1-1.2s.3,0,.3-.2,0-.3,0-.4c-.5-.5-.4-1.2,0-1.6s.3-.3.4-.4c.4-.3,1-.3,1.4,0s.3.2.4,0,.2-.2.2-.3c0-.6.5-1.1,1.1-1.1h.5c.6,0,1.1.5,1.1,1.1s.1.3.2.3c.2,0,.3,0,.4,0,.4-.4,1.1-.4,1.5,0l.4.4c.4.4.4,1.1,0,1.6s-.1.3,0,.4.2.2.3.2c.7,0,1.1.5,1.1,1.2v.4c0,.6-.5,1.1-1.1,1.1s-.3.1-.3.2c0,.2,0,.3.1.4.4.4.4,1,0,1.5l-.5.5c-.4.4-1.1.3-1.5,0s-.3-.1-.4,0-.2.2-.2.4c0,.6-.5,1.1-1.1,1.1ZM6.5,10.7c.2,0,.4-.2.4-.4,0-.5.3-.8.6-1s.9-.1,1.2.2.2.1.3.1.2,0,.3-.1l.3-.2c0,0,.2-.2.2-.3s0-.2-.2-.3c-.3-.3-.4-.8-.2-1.2s.5-.6,1-.6.4-.2.4-.4v-.4c0-.3-.2-.4-.4-.4-.4,0-.8-.3-1-.6s-.1-.9.2-1.2.2-.4,0-.6l-.3-.3c-.1-.1-.4-.1-.5,0-.3.3-.8.4-1.2.3s-.7-.5-.7-1-.2-.4-.4-.4h-.4c-.2,0-.4.2-.4.4,0,.5-.3.8-.7,1s-.9,0-1.2-.3-.4,0-.5,0l-.3.3c0,0-.2.2-.2.3s0,.2.2.3c.3.3.4.8.2,1.2s-.5.6-1,.6-.4.2-.4.4v.4c0,.3.2.4.4.4.4,0,.8.3,1,.6s.1.9-.2,1.2-.2.2-.2.3,0,.2.2.3l.3.3c.1.1.4.2.5,0,.3-.3.8-.4,1.2-.3s.7.6.7,1,.2.4.4.4h.4Z"/><path d="M8.6,6.1c0,1.3-1,2.3-2.3,2.3s-2.3-1-2.3-2.3,1-2.3,2.3-2.3,2.3,1,2.3,2.3ZM7.8,6.2c0-.9-.7-1.6-1.6-1.6s-1.6.7-1.6,1.6.7,1.6,1.6,1.6,1.6-.7,1.6-1.6Z"/>',
  desktop: '<path d="M6.4,11.4h-.5c-.6,0-1-.5-1-1.1s0-.3-.2-.3-.3,0-.4,0c-.4.4-1,.4-1.5,0l-.5-.5c-.4-.4-.3-1.1,0-1.5s.2-.2.1-.4-.2-.3-.3-.3c-.6,0-1-.4-1.1-.9s0-.4,0-.6c0-.6.5-1.2,1.1-1.2s.3,0,.3-.2,0-.3,0-.4c-.5-.5-.4-1.2,0-1.6s.3-.3.4-.4c.4-.3,1-.3,1.4,0s.3.2.4,0,.2-.2.2-.3c0-.6.5-1.1,1.1-1.1h.5c.6,0,1.1.5,1.1,1.1s.1.3.2.3c.2,0,.3,0,.4,0,.4-.4,1.1-.4,1.5,0l.4.4c.4.4.4,1.1,0,1.6s-.1.3,0,.4.2.2.3.2c.7,0,1.1.5,1.1,1.2v.4c0,.6-.5,1.1-1.1,1.1s-.3.1-.3.2c0,.2,0,.3.1.4.4.4.4,1,0,1.5l-.5.5c-.4.4-1.1.3-1.5,0s-.3-.1-.4,0-.2.2-.2.4c0,.6-.5,1.1-1.1,1.1ZM6.5,10.7c.2,0,.4-.2.4-.4,0-.5.3-.8.6-1s.9-.1,1.2.2.2.1.3.1.2,0,.3-.1l.3-.2c0,0,.2-.2.2-.3s0-.2-.2-.3c-.3-.3-.4-.8-.2-1.2s.5-.6,1-.6.4-.2.4-.4v-.4c0-.3-.2-.4-.4-.4-.4,0-.8-.3-1-.6s-.1-.9.2-1.2.2-.4,0-.6l-.3-.3c-.1-.1-.4-.1-.5,0-.3.3-.8.4-1.2.3s-.7-.5-.7-1-.2-.4-.4-.4h-.4c-.2,0-.4.2-.4.4,0,.5-.3.8-.7,1s-.9,0-1.2-.3-.4,0-.5,0l-.3.3c0,0-.2.2-.2.3s0,.2.2.3c.3.3.4.8.2,1.2s-.5.6-1,.6-.4.2-.4.4v.4c0,.3.2.4.4.4.4,0,.8.3,1,.6s.1.9-.2,1.2-.2.2-.2.3,0,.2.2.3l.3.3c.1.1.4.2.5,0,.3-.3.8-.4,1.2-.3s.7.6.7,1,.2.4.4.4h.4Z"/><path d="M8.6,6.1c0,1.3-1,2.3-2.3,2.3s-2.3-1-2.3-2.3,1-2.3,2.3-2.3,2.3,1,2.3,2.3ZM7.8,6.2c0-.9-.7-1.6-1.6-1.6s-1.6.7-1.6,1.6.7,1.6,1.6,1.6,1.6-.7,1.6-1.6Z"/>',
  keys: '<path d="M4.8,3c-.4,0-.8.3-.8.8v.6s5.6,0,5.6,0c.6,0,1.2.6,1.2,1.3v3.6c0,.7-.5,1.3-1.2,1.3H2.7c-.6,0-1.2-.6-1.2-1.3v-3.6c0-.7.5-1.3,1.2-1.3h.6s0-.7,0-.7c0-.9.7-1.6,1.5-1.6s.8.1,1.2.3.9.4,1.5.4.6,0,.8,0c.4-.1.9-.3,1.3-.6s.4,0,.5,0,0,.4-.1.5c-.5.4-1.1.6-1.8.7s-1,0-1.6,0-.8-.3-1.2-.5-.4-.1-.6-.1ZM9.6,9.9c.3,0,.5-.3.5-.6v-3.5c0-.3-.2-.6-.5-.6H2.7c-.3,0-.5.3-.5.6v3.5c0,.3.2.6.5.6h6.9Z"/><path d="M7.8,9.2h-3.3c-.2,0-.3-.1-.3-.4s.1-.4.3-.4h3.3c.2,0,.3.2.3.4s-.1.4-.3.4Z"/><path d="M3.6,9.2h-.3c-.1,0-.2-.1-.2-.2v-.2c0-.1,0-.3.2-.3h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M9,6.7h-.2c-.1,0-.2-.1-.2-.3v-.2c0-.1,0-.3.2-.3h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M3.5,7.9h-.2c-.1,0-.2-.1-.2-.3v-.2c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M9.1,9.2h-.3c-.1,0-.2-.1-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M3.5,6.7h-.2c-.1,0-.2-.1-.2-.3v-.2c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M4.7,7.9h-.2c-.1,0-.2-.1-.2-.2v-.3c0-.1.1-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M7.9,7.9h-.2c-.1,0-.2-.1-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.3v.2c0,.1,0,.2-.2.2Z"/><path d="M9.1,7.9h-.2c-.1,0-.2-.1-.2-.2v-.2c0-.1,0-.3.2-.3h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M4.6,6.7h-.2c-.1,0-.2-.1-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M7.9,6.7h-.2c-.1,0-.2-.1-.2-.3v-.2c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M5.7,7.9h-.2c-.1,0-.2,0-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M5.7,6.7h-.2c-.1,0-.2-.1-.2-.2v-.2c0-.1,0-.3.2-.3h.2c.1,0,.2.1.2.2v.3c0,.1,0,.2-.2.2Z"/><path d="M6.9,6.7h-.2c-.1,0-.2-.1-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.2c0,.1,0,.3-.2.3Z"/><path d="M6.8,7.9h-.2c-.1,0-.2,0-.2-.2v-.3c0-.1,0-.2.2-.2h.2c.1,0,.2.1.2.2v.2c0,.1,0,.3-.2.3Z"/>',
  providers: '<path d="M8,6.7c.2.8.9,1.2,1.7,1.1.8-.1,1.3-.8,1.3-1.6,0-.8-.6-1.4-1.4-1.5-.7,0-1.4.4-1.6,1.1h-1.5s-.2-.7-.2-.7l1.7-1.1c.6.5,1.5.5,2.1,0,.6-.5.6-1.4.2-2-.5-.6-1.3-.8-2-.4-.7.4-1,1.1-.7,1.8l-1.7,1.1c-.5-.5-1.1-.8-1.8-.9-.7,0-1.5.2-2,.8-.5.5-.8,1.2-.8,1.9,0,.7.3,1.4.9,1.9.5.5,1.2.8,2,.7.7,0,1.3-.3,1.8-.9l1.7,1.1c-.2.7,0,1.5.7,1.8.2.1.5.2.7.2.5,0,1-.2,1.3-.7.4-.6.3-1.5-.3-2.1-.5-.4-1.3-.4-2,0l-1.7-1.1.2-.7h1.5ZM8.8,6.3c0-.4.3-.7.7-.7s.7.3.7.7-.3.7-.7.7-.7-.3-.7-.7ZM9.6,2.9c0,.4-.3.7-.7.7s-.7-.3-.7-.7.3-.7.7-.7.7.3.7.7ZM5.7,6.3c0,1-.8,1.8-1.8,1.8s-1.8-.8-1.8-1.8.8-1.8,1.8-1.8,1.8.8,1.8,1.8ZM8.2,9.7c0-.4.3-.7.7-.7s.7.3.7.7-.3.7-.7.7-.7-.3-.7-.7Z"/>',
  api: '<path d="M9.5,6.6c-.7.6-1.7.8-2.6.4l-3.9,3.7s-.1,0-.2,0h-1.4c0,0,0,0-.1,0h0c0-.1,0-.2,0-.3l.4-1.6s0,0,0-.1l.4-.4s0,0,.1,0h.7s0-.7,0-.7c0-.1.1-.2.3-.2h.6s0-.7,0-.7c0-.1.1-.2.2-.2h.6s0-.7,0-.7c0,0,0,0,0-.1l.6-.5c-.3-.9,0-1.9.5-2.6s1.2-.9,2-.9h.1c.6,0,1.2.3,1.6.7h0s.3.3.3.3c.9,1,.8,2.5,0,3.5l-.3.3ZM3.2,7.9v.7c0,0-.1.2-.2.2h-.8s-.3.2-.3.2l-.3,1.3h1.1s3.9-3.7,3.9-3.7c0,0,.1,0,.2,0,.8.4,1.8.2,2.5-.4s.7-1.1.7-1.7c0-1.3-1.1-2.2-2.3-2.2s-1.5.4-1.9,1.1-.4,1.3-.2,2,0,.2,0,.2l-.6.5v.8c0,0-.1.2-.2.2h-.7s0,.7,0,.7c0,0,0,.2-.2.2h-.7Z"/><path d="M7.5,4.8c-.4-.4-.3-1,0-1.3s1-.3,1.3,0,.3,1,0,1.3-1,.3-1.3,0ZM7.8,4.5c.2.2.5.2.7,0s.2-.5,0-.7-.5-.2-.7,0-.2.5,0,.7Z"/>',
  plugins: '<path d="M8.4,8.4c0,1.2-1,2.2-2.2,2.2s-2.2-.9-2.2-2.2c-1.2,0-2.2-1-2.2-2.2s.9-2.2,2.2-2.2c0-1.2,1-2.2,2.2-2.2s2.2.9,2.2,2.2c1.2,0,2.2,1,2.2,2.2s-.9,2.2-2.2,2.2ZM5.2,3.8c0-.6.7-.9,1.1-.9s.9.5.9,1.1h.6c0-1.1-.8-1.7-1.7-1.7s-1.6.7-1.6,1.6v2.8s.6,0,.6,0v-2.9ZM6.7,4c0-.4-.3-.5-.6-.5s-.4.2-.5.5h1.1ZM3.8,7.2c-.6,0-1-.7-.9-1.1s.4-.9,1-.9v-.6c-1,0-1.7.8-1.7,1.7s.7,1.7,1.6,1.7h2.8s0-.6,0-.6h-2.9ZM8.4,7.3v.6c1,0,1.7-.7,1.7-1.6s-.7-1.7-1.6-1.7h-2.8s0,.6,0,.6h2.8c.6,0,1,.5,1,1.1s-.5,1-1.1,1ZM4,5.7c-.5,0-.5.3-.5.6s.2.4.5.5v-1ZM6.7,5.7h-1v1h1v-1ZM4.5,8.4c0,1,.8,1.7,1.7,1.7s1.6-.7,1.6-1.6v-2.7s-.6,0-.6,0v2.6c0,.6-.4,1.1-1,1.2s-1.1-.4-1.1-1.1h-.6ZM8.4,6.7c.5,0,.5-.4.5-.6s-.3-.4-.5-.4v1ZM6.7,8.4h-1c0,.4.3.5.6.5s.5-.2.5-.5Z"/>',
  connectors: '<path d="M7.6,11.6h-1.2c0,0-.2-.1-.2-.2v-1.2s-.7,0-.7,0c-.1,0-.2,0-.2-.2v-.8s-.4,0-.4,0c-.8,0-1.4-.6-1.4-1.4v-3.4c0-.1.1-.2.2-.2h.7s0-2.7,0-2.7c0-.5.4-.8.8-.8s.8.4.8.8v2.7h1.7V1.6c0-.5.4-.8.8-.8s.8.3.8.8v2.7s.7,0,.7,0c.1,0,.2,0,.2.2v3.4c0,.8-.6,1.4-1.4,1.4h-.4s0,.7,0,.7c0,.1,0,.2-.2.2h-.7s0,1.2,0,1.2c0,.1,0,.2-.2.2ZM5.7,4.3V1.6c0-.2-.2-.4-.4-.4s-.4.2-.4.4v2.6s.8,0,.8,0ZM9.1,4.3V1.6c0-.2-.2-.4-.4-.4s-.4.2-.4.4v2.6s.8,0,.8,0ZM9.1,8.8c.5,0,.9-.4.9-.9v-2.2s-1.2,0-1.2,0c-.1,0-.2-.1-.2-.2s0-.2.2-.2h1.2s0-.6,0-.6H4s0,.6,0,.6h3c.1,0,.2.1.2.2s0,.2-.2.2h-3s0,2.1,0,2.1c0,.5.4,1,1,1h4.2ZM5.7,9.2v.5h2.5v-.5h-2.5ZM7.3,10.2h-.6v1h.6v-1Z"/><path d="M8,5.3c.1,0,.2.2.1.3s-.1.2-.2.2-.2,0-.2-.2,0-.2.1-.3.1,0,.2,0Z"/>',
  extensions: '<path d="M8.1,9.8h-1.3c-.2,0-.3-.2-.3-.3v-.5c0-.2,0-.3-.2-.4-.1-.1-.4-.2-.6-.2-.4,0-.7.4-.7.8v.4c0,.2-.2.3-.3.3h-1.3c-.6,0-1-.5-1-1v-1.3c0-.2.2-.3.3-.3h.5c.2,0,.3,0,.5-.2.1-.2.2-.4.2-.6,0-.4-.3-.7-.7-.7h-.5c-.2,0-.3-.2-.3-.3v-1.3c0-.6.5-1,1-1h1.2v-.3s0,0,0,0c0-.3.1-.6.4-.9.2-.2.5-.4.9-.3.3,0,.6.1.9.4.2.2.4.5.4.9v.3h1.2c.6,0,1,.5,1,1v1.2h.3c.3,0,.6.1.9.3.2.2.4.5.4.9s-.1.6-.4.9c-.2.2-.5.4-.9.4h-.3v1.2c0,.6-.5,1-1,1ZM2.8,7.7v1.1c0,.2.2.4.4.4h1.1c0-.5.1-.8.4-1.1.3-.3.6-.4.9-.4.4,0,.8.1,1,.4.2.2.4.5.4.9v.3h1.1c.2,0,.4-.2.4-.4v-1.5c0-.2.2-.3.3-.3h.5c.3,0,.6-.3.6-.6s-.3-.6-.6-.6h-.5c-.2,0-.3-.2-.3-.3v-1.5c0-.2-.2-.4-.4-.4h-1.5c-.2,0-.3-.2-.3-.3v-.5c0-.4-.3-.6-.6-.6-.3,0-.6.3-.6.6,0,0,0,0,0,0v.5c0,.2-.2.3-.3.3h-1.5c-.2,0-.4.2-.4.4v1.1h.2c.3,0,.7.1.9.4.2.3.4.6.4.9,0,.4-.1.7-.4,1-.2.3-.6.4-.9.4h-.3Z"/>',
  developer: '<path d="M10.5,2.4H2c-.5,0-1,.4-1,.9v6.2c0,.5.4.9,1,.9h8.5c.5,0,1-.4,1-.9V3.3c0-.5-.4-.9-1-.9ZM10.5,10H2c-.3,0-.5-.2-.5-.5v-5.1h9.4v5.1c0,.2-.2.5-.5.5ZM2,2.9h8.5c.3,0,.5.2.5.5v.7H1.5v-.7c0-.2.2-.5.5-.5Z"/><circle cx="7.9" cy="3.5" r=".3"/><circle cx="8.8" cy="3.5" r=".3"/><circle cx="9.7" cy="3.5" r=".3"/><path d="M3.6,7.5l2,1s0,0,0,0,0,0,.1,0c0,0,.1-.1.1-.2s0-.2-.1-.2l-1.8-.9,1.8-.9c0,0,.1-.1.1-.2s0-.1-.1-.2c0,0-.1,0-.2,0l-2,1c0,0-.1.1-.1.2h0c0,.2,0,.2.1.3Z"/><path d="M6.7,8.3c0,0,0,.1.1.2,0,0,0,0,.1,0s0,0,0,0l2-1c0,0,.1-.1.1-.2h0c0-.2,0-.2-.1-.3l-2-1c0,0-.1,0-.2,0,0,0-.1.1-.1.2s0,.2.1.2l1.8.9-1.8.9c0,0-.1.1-.1.2Z"/>',
  skills: '<path d="M9.7,8c0,0,0,.2,0,.2s-.2,0-.3,0l-.8-.7c0,0,0-.2,0-.2s.2,0,.3,0l.8.7Z"/><path d="M11,5.4h-1.2c-.1,0-.2,0-.2-.2s0-.2.2-.2h1.2c.1,0,.2,0,.2.2s0,.2-.2.2Z"/><path d="M6.5,2.1c0,.1,0,.2-.2.2s-.2,0-.2-.2v-1c0,0,0-.2.2-.2s.2,0,.2.2v1Z"/><path d="M8.9,3.1c0,0-.2,0-.3,0s0-.2,0-.2l.8-.7c0,0,.2,0,.3,0s0,.2,0,.2l-.8.7Z"/><path d="M7.3,10.7c0,.4-.3.7-.8.7h-1.4c-.4,0-.8-.3-.8-.7h-.2c-.3,0-.5-.2-.6-.3s0-.5.1-.7c-.1-.2-.2-.4-.2-.6s.2-.3.5-.4c0,0-.2-.2-.2-.3-.4,0-.8-.1-1-.4s-.3-.7-.2-1c-.5-.2-.8-.7-.8-1.2s.3-.9.8-1.2c-.1-.4,0-.7.2-1s.7-.4,1-.4c.2-.4.7-.7,1.2-.6s.9.5.9.9v4.6c0,.2-.1.4-.3.6h.5s0-5.8,0-5.8c0-.2.2-.4.5-.4,1.2,0,2.2.8,2.5,1.7s.1,2.2-.8,2.9-.8.9-.8,1.5c.3,0,.5.1.6.3s0,.5-.1.7c.1.2.3.4.1.6s-.3.4-.6.4h-.2ZM3.7,6.3c0,0,0,.1-.1.2-.3,0-.5.2-.6.4s-.1.5,0,.8.4.4.8.4c0-.3.2-.5.4-.6s.2,0,.2,0,0,.2,0,.2c-.2,0-.3.2-.3.3,0,.3.3.6.7.6s.7-.3.7-.6V3.4c0-.3-.3-.5-.6-.6s-.6,0-.8.4c.3,0,.5.3.6.5s0,.2-.1.2-.2,0-.2,0c-.1-.2-.4-.3-.6-.4s-.6,0-.8.3-.3.5-.1.8c.4,0,.7,0,.9.3s0,.2,0,.2-.2,0-.3,0c-.2-.2-.5-.3-.8-.2-.4.1-.7.5-.7.9s.2.8.6.9c.2-.3.9-.6,1-.3ZM7.1,8.7c0-.7.4-1.3.9-1.7.6-.5,1-1.2.9-2-.1-1.1-1.1-2.1-2.5-2.2v5.8s.6,0,.6,0ZM7.5,9h-3.3c-.2,0-.3.1-.3.3s.1.3.3.3h3.3c.2,0,.3-.1.3-.3s-.1-.2-.3-.2ZM7.6,10.3c.2,0,.3-.2.2-.3s-.2-.2-.3-.2h-3.3c-.2,0-.3.1-.3.3s0,.3.2.3h3.4ZM6.6,11.1c.3,0,.4-.2.4-.4h-2.2c0,.2.2.4.4.4h1.4Z"/><path d="M8.6,5.2c0,.1,0,.2-.2.2s-.2,0-.2-.2c0-.7-.5-1.4-1.3-1.6s-.1-.1,0-.2.1-.1.2,0c.9.3,1.5,1,1.5,1.9Z"/>',
};
const icon = name => ICON_MARKUP[name] ? `<svg viewBox="0 0 12.5 12.5" fill="currentColor" aria-hidden="true">${ICON_MARKUP[name]}</svg>` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.general}"/></svg>`;

export function mountSettingsSurfaces(api) {
  const settings = $('settings');
  const oldNav = settings?.querySelector('.settings-nav');
  const actionBar = settings?.querySelector('.settings-actions');
  if (!settings || !oldNav || !actionBar) return {refresh(){}, frame(){}, settingsApplied(){}, dispose(){}};
  const L = api.L;
  let lang = api.state?.lang === 'ar' ? 'ar' : 'en';
  let directoryTab = 'skills';
  let directory;
  let desktopState = null;
  let desktopDraft = null;
  let desktopLoading = false;
  let desktopSaving = false;
  let remoteStatus = null;// م5 — آخرُ إطار remote-control من المحرّك (off | on + المنفذ والعناوين والرمز والعملاء)
  const addedPanels = new Map();
  const addedNav = [];
  const languageRow=$('setlanguage')?.closest('.setting-row');
  if($('setlanguage')){const selected=$('setlanguage').value;$('setlanguage').replaceChildren(...languageChoices().map(item=>{const option=node('option','',item.label);option.value=item.code;return option;}));$('setlanguage').value=selected||'en';}


  const t = (en, ar) => lang === 'ar' ? ar : en;
  const protect = n => { n.dataset.userContent = ''; return n; };
  const snapshot = () => api.bridge.snapshot();
  const state = () => api.state || {};
  const nativeSettings = id => api.native.settings(id);
  const closeSettings = () => {$('settingsclose')?.click();};
  const go = page => { closeSettings(); api.showPage(page); };

  // Original buttons stay in the DOM for native.settings(id), including their established click handlers.
  for (const button of oldNav.querySelectorAll(':scope > button')) { button.hidden = true; button.classList.add('nss-original-nav'); }
  const search = node('input', 'nss-nav-search');
  search.type = 'search'; search.placeholder = t('Search settings', 'ابحث في الإعدادات');
  search.setAttribute('aria-label', search.placeholder);
  oldNav.prepend(search);

  const groups = () => [
    [t('Settings','الإعدادات'), [
      ['general',t('General','عام'),'general'], ['nss-language',t('Language','اللغة'),'language'], ['nss-account',t('Account','الحساب'),'account'], ['nss-privacy',t('Privacy','الخصوصية'),'privacy'],
      ['nss-billing',t('Billing','الفوترة'),'billing'], ['nss-usage',t('Usage','الاستخدام'),'usage'], ['nss-capabilities',t('Capabilities','الإمكانات'),'capabilities'],
      ['nss-code',t('AbdoCode','عبدو كود'),'code'], ['nss-cowork',t('Cowork','العمل المشترك'),'cowork'], ['nss-chrome',t('Abdo in Chrome','عبدو في كروم'),'chrome']]],
    [t('Desktop app','تطبيق سطح المكتب'), [
      ['nss-desktop',t('General','عام'),'desktop'], ['nss-extensions',t('Extensions','الامتدادات'),'extensions'], ['nss-remote',t('Abdo Remote Control','عبدو ريموت كونترول'),'remote'], ['nss-developer',t('Developer','المطوّر'),'developer']]],
    [t('Customize','التخصيص'), [
      ['nss-templates',t('Project templates','قوالب المشاريع'),'layout'], ['skills',t('Skills','المهارات'),'skills'], ['connections',t('Connectors','الموصلات'),'connectors'], ['plugins',t('Plugins','الإضافات'),'plugins'], ['memory',t('Memory','الذاكرة'),'memory']]],
    [t('Platform','المنصة'), [['nss-api',t('API keys','مفاتيح API'),'api']]],
    [t('Native controls','أدوات عبدو كود'), [
      ['providers',t('Providers','المزوّدون'),'providers'], ['models',t('Models','النماذج'),'models'], ['permissions',t('Permissions','الصلاحيات'),'permissions'],
      ['keys',t('Keyboard shortcuts','اختصارات لوحة المفاتيح'),'keys'], ['runtime',t('Runtime & security','التشغيل والأمان'),'runtime'], ['super',t('Super Abdo Mode','وضع سوبر عبدو'),'super'], ['layout',t('Panels & layout','الألواح والتخطيط'),'layout']]]
  ];

  function openPanel(id) {
    settings.querySelectorAll('[data-settings-panel]').forEach(b => b.classList.toggle('active', b.dataset.settingsPanel === id));
    settings.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === id));
    settings.querySelector(`[data-panel="${CSS.escape(id)}"]`)?.scrollTo?.(0,0);
    document.dispatchEvent(new CustomEvent('abdocode:settings-opened',{detail:{id}}));
    if(id==='nss-desktop')void loadDesktopPreferences(true);
  }
  function buildNav() {
    for (const n of addedNav.splice(0)) n.remove();
    for (const [title, entries] of groups()) {
      const group = node('div','nss-nav-group');
      group.append(node('div','nss-nav-heading',title));
      for (const [id,label,image] of entries) {
        const b = node('button','nss-nav-item'); b.type='button'; b.dataset.settingsPanel=id;
        b.dataset.search = `${title} ${label} ${id==='nss-language'?'language languages locale translation English Arabic اللغة اللغات عربي انجليزي':''}`.toLowerCase(); b.innerHTML=icon(image); b.append(document.createTextNode(label));
        b.onclick=()=>openPanel(id); group.append(b);
      }
      oldNav.append(group); addedNav.push(group);
    }
    const active = settings.querySelector('.settings-panel.active')?.dataset.panel || 'general';
    settings.querySelectorAll('.nss-nav-item').forEach(b=>b.classList.toggle('active',b.dataset.settingsPanel===active));
  }
  search.oninput = () => {
    const q=search.value.trim().toLowerCase();
    for(const group of oldNav.querySelectorAll('.nss-nav-group')) {
      let shown=0; for(const b of group.querySelectorAll('button')) { const panel=settings.querySelector(`[data-panel="${CSS.escape(b.dataset.settingsPanel)}"]`);const content=(panel?.textContent||'').toLowerCase();b.hidden=!!q&&!(`${b.dataset.search} ${content}`).includes(q); if(!b.hidden)shown++; }
      group.hidden=shown===0;
    }
  };

  function addPanel(id, title) {
    let panel=settings.querySelector(`[data-panel="${CSS.escape(id)}"]`);
    if(!panel){panel=node('section','settings-panel nss-surface');panel.dataset.panel=id;actionBar.before(panel);addedPanels.set(id,panel);}
    panel.inert=settings.getAttribute('aria-busy')==='true';panel.replaceChildren(node('h3','',title));
    return panel;
  }
  const summary = (panel, text) => panel.append(node('p','nss-summary',text));
  function fact(panel,label,value,detail='') {
    const row=node('div','nss-fact');const copy=node('div');copy.append(node('strong','',label));if(detail)copy.append(node('small','',detail));
    const valueNode=protect(node('span','nss-value',String(value)));row.append(copy,valueNode);panel.append(row);return row;
  }
  function action(panel,label,detail,run,kind='') {
    const row=node('div','nss-action-row');const copy=node('div');copy.append(node('strong','',label));if(detail)copy.append(node('small','',detail));
    const b=node('button','nss-action '+kind,t('Open','فتح'));b.type='button';b.onclick=run;row.append(copy,b);panel.append(row);return b;
  }
  const unavailable = panel => {const badge=node('span','nss-status nss-status-neutral',t('Not connected','غير متصل'));panel.append(badge);};
  async function setPreference(key,value) {
    const meta=state().metadata;if(!meta)return;

    try{await writeWorkspacePreference(meta,key,value,()=>api.saveStore());api.applyWorkspacePreferences?.();renderPanels();api.bridge.notice?.(t('Workspace preference saved.','حُفظ تفضيل مساحة العمل.'));}
    catch(error){renderPanels();api.bridge.notice?.(t('Could not save workspace preference: ','تعذر حفظ تفضيل مساحة العمل: ')+String(error));}
  }
  function prefToggle(panel,key,label,detail,value){const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));const input=node('input');input.type='checkbox';input.checked=value!==false;input.onchange=()=>setPreference(key,input.checked);row.append(copy,input);panel.append(row);return input;}
  function prefSelect(panel,key,label,detail,value,options){const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));const select=node('select');for(const [id,text]of options){const option=node('option','',text);option.value=String(id);select.append(option);}select.value=String(value);select.onchange=()=>setPreference(key,/^\d+$/.test(select.value)?Number(select.value):select.value);row.append(copy,select);panel.append(row);return select;}
  function prefText(panel,key,label,detail,value,validate){const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));const input=node('input');input.value=value||'';input.dir='ltr';input.onchange=()=>{const next=input.value.trim();const refusal=validate?.(next);if(refusal){api.bridge.notice?.(refusal);input.value=value||'';return;}setPreference(key,next);};row.append(copy,input);panel.append(row);return input;}

  function desktopControl(panel, field, label, detail) {
    const capabilities=desktopState?.capabilities||{};const supported=capabilities[field]!==false;
    const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));
    const box=node('input');box.type='checkbox';box.checked=!!desktopDraft?.[field];box.disabled=!supported||desktopSaving;
    box.onchange=()=>{desktopDraft={...desktopDraft,[field]:box.checked};};
    row.append(copy,box);const fieldError=desktopState?.errors?.some(error=>error.field===field);const actual=desktopState?.applied?.[field];
    if(!supported)row.append(node('em','nss-status',t('Unsupported in this build','غير مدعوم في هذا الإصدار')));
    else if(fieldError)row.append(node('em','nss-status nss-status-warning',t('Current state not confirmed','لم تُؤكد الحالة الحالية')));
    else if(typeof actual==='boolean'&&actual!==box.checked)row.append(node('em','nss-status nss-status-warning',actual?t('Currently on','مفعّل حاليًا'):t('Currently off','معطّل حاليًا')));
    panel.append(row);
  }
  function renderDesktop(panel,snap) {
    summary(panel,t('Control Windows behavior for this AbdoCode installation. Changes are applied by the native desktop process.','تحكّم في سلوك Windows لهذا التثبيت من عبدو كود. يطبق تطبيق سطح المكتب الأصلي التغييرات.'));
    fact(panel,t('Local engine','المحرك المحلي'),snap.engineUp?t('Connected','متصل'):t('Unavailable','غير متاح'));
    if(desktopLoading&&!desktopState){fact(panel,t('Windows settings','إعدادات Windows'),t('Loading…','جارٍ التحميل…'));return;}
    if(!desktopState||!desktopDraft){fact(panel,t('Windows settings','إعدادات Windows'),t('Could not read current state','تعذرت قراءة الحالة الحالية'),t('Reopen settings to try again.','أعد فتح الإعدادات للمحاولة مجددًا.'));return;}
    desktopControl(panel,'runOnStartup',t('Run on startup','التشغيل عند بدء النظام'),t('Start AbdoCode when you sign in to Windows.','ابدأ عبدو كود عند تسجيل الدخول إلى Windows.'));
    desktopControl(panel,'systemTray',t('System tray','صينية النظام'),t('Keep the desktop process available from the notification area.','أبقِ تطبيق سطح المكتب متاحًا من منطقة الإشعارات.'));
    desktopControl(panel,'keepComputerAwake',t('Keep computer awake','إبقاء الكمبيوتر مستيقظًا'),t('Prevent idle sleep while AbdoCode is open; the display may still turn off.','امنع السكون الخامل أثناء فتح عبدو كود؛ وقد تظل الشاشة قابلة للإطفاء.'));
    const quickSupported=desktopState.capabilities?.quickEntryShortcut!==false;const quick=node('div','nss-pref-row');const qcopy=node('span');qcopy.append(node('strong','',t('Quick Entry keyboard shortcut','اختصار الإدخال السريع')),node('small','',t('Open AbdoCode from anywhere in Windows.','افتح عبدو كود من أي مكان في Windows.')));const qtoggle=node('input');qtoggle.type='checkbox';qtoggle.checked=!!desktopDraft.quickEntry?.enabled;qtoggle.disabled=desktopSaving||(!quickSupported&&!qtoggle.checked);const qkey=node('input','nss-shortcut');qkey.dir='ltr';qkey.value=desktopDraft.quickEntry?.shortcut||'Ctrl+Alt+Space';qkey.disabled=!quickSupported||desktopSaving;const setQuick=()=>{desktopDraft={...desktopDraft,quickEntry:{enabled:qtoggle.checked,shortcut:qkey.value.trim()||'Ctrl+Alt+Space'}};};qtoggle.onchange=setQuick;qkey.oninput=setQuick;quick.append(qcopy,qkey,qtoggle);if(!quickSupported)quick.append(node('em','nss-status',qtoggle.checked?t('Turn it off to clear the unsupported saved request','عطّله لمسح الطلب المحفوظ غير المدعوم'):t('Unsupported in this build','غير مدعوم في هذا الإصدار')));panel.append(quick);
    if(desktopState.errors?.length){const errors=node('div','nss-pref-errors');errors.append(node('strong','',t('Windows reported:','أبلغ Windows:')));for(const error of desktopState.errors)errors.append(protect(node('p','',error.message||error.code||String(error))));panel.append(errors);}
    const apply=node('button','nss-action primary',desktopSaving?t('Applying…','جارٍ التطبيق…'):t('Apply desktop settings','تطبيق إعدادات سطح المكتب'));apply.type='button';apply.disabled=desktopSaving;
    apply.onclick=async()=>{if(desktopSaving)return;desktopSaving=true;renderPanels();try{const requested={version:1,runOnStartup:!!desktopDraft.runOnStartup,systemTray:!!desktopDraft.systemTray,keepComputerAwake:!!desktopDraft.keepComputerAwake,quickEntry:{enabled:!!desktopDraft.quickEntry?.enabled,shortcut:desktopDraft.quickEntry?.shortcut||'Ctrl+Alt+Space'}};const result=await api.bridge.invoke('desktop_preferences_set',{preferences:requested});desktopState=await api.bridge.invoke('desktop_preferences_get').catch(()=>result);desktopDraft=structuredClone(desktopState.preferences);api.bridge.notice?.(desktopState.errors?.length?t('Some Windows settings could not be applied.','تعذر تطبيق بعض إعدادات Windows.'):t('Desktop settings applied.','تم تطبيق إعدادات سطح المكتب.'));}catch(error){api.bridge.notice?.(t('Could not apply desktop settings: ','تعذر تطبيق إعدادات سطح المكتب: ')+String(error));}finally{desktopSaving=false;renderPanels();}};
    panel.append(apply);
  }
  async function loadDesktopPreferences(force=false){if(desktopLoading||(!force&&desktopState)||typeof api.bridge.invoke!=='function')return;desktopLoading=true;try{desktopState=await api.bridge.invoke('desktop_preferences_get');desktopDraft=structuredClone(desktopState.preferences);}catch(error){api.bridge.notice?.(t('Could not read desktop settings: ','تعذرت قراءة إعدادات سطح المكتب: ')+String(error));}finally{desktopLoading=false;renderPanels();}}

  function renderPanels() {
    const snap=snapshot(), runtime=snap.settings||{}, shell=snap.shell||{}, meta=state().metadata||{projects:[],schedules:[]};
    const registry=snap.pluginRegistry; const configured=(runtime.mcpServers||[]); const custom=(runtime.customProviders||[]);
    let languagePanel=addPanel('nss-language',t('Language','اللغة'));
    summary(languagePanel,t('Choose your preferred language for AbdoCode responses. English is the default. File paths, code and your existing content keep their original form.','اختر لغة ردود عبدو كود. الإنجليزية هي الافتراضية. تبقى المسارات والأكواد والمحتوى الموجود بصيغتها الأصلية.'));
    if(languageRow)languagePanel.append(languageRow);
    summary(languagePanel,t('Interface translations are currently available in English and Arabic. Other language choices use English for untranslated interface text; the agent responds in your selected language.','ترجمة الواجهة الكاملة متاحة حاليًا بالعربية والإنجليزية. عند اختيار لغة أخرى يظهر نص الواجهة غير المترجم بالإنجليزية، ويرد الوكيل باللغة المختارة.'));
    renderTemplateSettings(addPanel('nss-templates',t('Project templates','قوالب المشاريع')),api,lang);
    let p=addPanel('nss-account',t('Account','الحساب'));
    summary(p,t('This native workspace does not require a cloud account. Projects, sessions and preferences are stored on this computer.','مساحة العمل الأصلية هذه لا تتطلب حسابًا سحابيًا. تُحفظ المشاريع والجلسات والتفضيلات على هذا الجهاز.'));unavailable(p);
    fact(p,t('Workspace','مساحة العمل'),t('Local','محلية'),t('No cloud identity is attached to this shell.','لا توجد هوية سحابية مرتبطة بهذه القشرة.'));
    action(p,t('Projects','المشاريع'),t(`${(meta.projects||[]).length} saved locally`,`${(meta.projects||[]).length} محفوظة محليًا`),()=>go('projects'));

    p=addPanel('nss-privacy',t('Privacy','الخصوصية'));
    summary(p,t('Credentials stay in the native vault. Model requests leave the computer only through the provider you configure.','تبقى بيانات الاعتماد في الخزنة الأصلية. لا تغادر طلبات النموذج الجهاز إلا عبر المزوّد الذي تضبطه.'));
    action(p,t('Session permissions','صلاحيات الجلسة'),t('Review grants, repeated denials and the approval mode.','راجع المنح والرفض المتكرر ونمط الموافقة.'),()=>nativeSettings('permissions'));
    action(p,t('Provider credentials','بيانات اعتماد المزوّدين'),t('Keys are written directly to the vault and are not returned to the page.','تُكتب المفاتيح مباشرة في الخزنة ولا تُعاد إلى الصفحة.'),()=>nativeSettings('providers'));
    action(p,t('Project instructions','تعليمات المشروع'),t('Inspect or edit what is sent with work in each project.','اعرض أو عدّل ما يُرسل مع العمل في كل مشروع.'),()=>go('projects'));

    p=addPanel('nss-billing',t('Billing','الفوترة'));
    summary(p,t('AbdoCode does not receive plan, balance or invoice data from model providers. Billing remains in each provider’s own account.','لا يستقبل عبدو كود بيانات الخطة أو الرصيد أو الفواتير من مزوّدي النماذج. تبقى الفوترة داخل حساب كل مزوّد.'));
    fact(p,t('Billing status','حالة الفوترة'),t('Kept by each provider — open its console for balance and invoices','لدى كلّ مزوّد في حسابه — الرصيد والفواتير من لوحته'));
    // م8 (09-14): جدولُ الشراء وخطّةُ البيع (ذ6) كانا مفتاحين بلا واجهة — JSON يفحصه المحرّك عند الحفظ ويرفضه بالاسم.
    const jsonRow=(label,detail,value,onApply)=>{const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));const area=node('textarea');area.dir='ltr';area.rows=3;area.value=value?JSON.stringify(value):'';area.onchange=async()=>{area.disabled=true;try{const parsed=area.value.trim()?JSON.parse(area.value):undefined;await onApply(parsed);api.bridge.notice?.(t('Setting applied.','طُبق الإعداد.'));}catch(error){api.bridge.notice?.(String(error));}finally{area.disabled=false;}};row.append(copy,area);p.append(row);};
    jsonRow(t('Price table (halalas per million tokens)','جدولُ الشراء (هللات لكلّ مليون توكن)'),t('JSON list of {ref, buyInPerMillion, buyOutPerMillion} — owner-entered; no default price is assumed.','قائمةُ JSON من {ref, buyInPerMillion, buyOutPerMillion} — يدخلها المالك؛ لا سعرَ افتراضيّ.'),runtime.priceTable,v=>api.applyRuntimeSettings({priceTable:v??[]}));
    jsonRow(t('Sell plan','خطّةُ البيع'),t('JSON {id, sellPerMillion, quotaHalalas} — empty = no selling, no quota.','JSON {id, sellPerMillion, quotaHalalas} — فارغ = لا بيع ولا حصّة.'),runtime.sellPlan,v=>api.applyRuntimeSettings({sellPlan:v}));
    action(p,t('Configured providers','المزوّدون المضبوطون'),t(`${custom.length} custom configuration(s)`,`${custom.length} إعدادات مخصصة`),()=>nativeSettings('providers'));

    p=addPanel('nss-usage',t('Usage','الاستخدام'));
    summary(p,t('The local runtime records session activity, but it cannot read subscription quotas or reset times from provider accounts.','يسجل المحرك المحلي نشاط الجلسة، لكنه لا يستطيع قراءة حصص الاشتراك أو مواعيد التجديد من حسابات المزوّدين.'));
    fact(p,t('Local sessions','الجلسات المحلية'),(state().sessions||[]).length);
    fact(p,t('Provider limits','حدود المزوّد'),t('Not reported','لم يُبلّغ عنها'));
    action(p,t('Runtime details','تفاصيل التشغيل'),t('Inspect the local engine and notification behavior.','اعرض المحرك المحلي وسلوك الإشعارات.'),()=>nativeSettings('runtime'));

    p=addPanel('nss-capabilities',t('Capabilities','الإمكانات'));
    summary(p,t('Capabilities come from the engine registry. Disabled entries are not loaded into the next turn.','تأتي الإمكانات من سجل المحرك. لا تُحمّل العناصر المعطلة في الدور التالي.'));
    fact(p,t('Registered','المسجّلة'),Array.isArray(registry?.descriptors)?registry.descriptors.length:t('Waiting for engine','بانتظار المحرك'));
    fact(p,t('Enabled now','المفعّل الآن'),registry?.effective?Object.values(registry.effective).filter(Boolean).length:t('Unknown','غير معروف'));
    action(p,t('Plugin registry','سجل الإضافات'),t('Configure the exact features exposed to the agent.','اضبط الميزات المحددة التي تظهر للوكيل.'),()=>nativeSettings('plugins'));
    action(p,t('External tools','الأدوات الخارجية'),t(`${configured.length} MCP server configuration(s)`,`${configured.length} إعدادات لخوادم MCP`),()=>nativeSettings('connections'));
    action(p,t('Browse directory','تصفح الدليل'),t('Inspect native skills, connectors and plugins.','اعرض المهارات والموصلات والإضافات الأصلية.'),()=>openDirectory('skills'),'primary');

    p=addPanel('nss-code',t('AbdoCode','عبدو كود'));
    summary(p,t('Choose model routing, approval behavior, Super Abdo verification and the workspace layout.','اختر توجيه النماذج وسلوك الموافقة وتحقق سوبر عبدو وتخطيط مساحة العمل.'));
    fact(p,t('Default model','النموذج الافتراضي'),(api.state.shellMode==='chat'?runtime.chatModel:runtime.agentModel)||runtime.model||api.bridge.providers.DEFAULT_MODEL);
    fact(p,t('Current project','المشروع الحالي'),snap.project||t('No project','لا مشروع'));
    // م8 (09-14): مفتاحان كان يقبلهما المحرّك بلا موضعٍ في الواجهة — نموذجُ البوّابة وسلّمُ التصعيد.
    const textRow=(panel,label,detail,value,onApply,placeholder='')=>{const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',label),node('small','',detail));const input=node('input');input.type='text';input.dir='ltr';input.value=value;input.placeholder=placeholder;input.onchange=async()=>{input.disabled=true;try{await onApply(input.value.trim());api.bridge.notice?.(t('Setting applied.','طُبق الإعداد.'));}catch(error){api.bridge.notice?.(String(error));}finally{input.disabled=false;}};row.append(copy,input);panel.append(row);};
    textRow(p,t('Router gate model','نموذج بوّابة التوجيه'),t('provider/model used by the cheap front gate; empty = the chat-lane model.','مزوّد/نموذج تستعمله البوّابةُ الأماميّة الرخيصة؛ فارغ = نموذجُ حارة الدردشة.'),runtime.gateModel||'',v=>api.applyRuntimeSettings({gateModel:v}),'qwen-token-plan/qwen3.7-flash');
    textRow(p,t('Model ladder','سلّم التصعيد'),t('Comma-separated provider/model refs from cheapest to strongest; empty = no escalation.','مراجعُ نماذج مفصولةٌ بفواصل من الأرخص إلى الأقدر؛ فارغ = لا تصعيد.'),(runtime.modelLadder||[]).join(', '),v=>api.applyRuntimeSettings({modelLadder:v?v.split(/\s*,\s*/).filter(Boolean):[]}),'ollama/qwen9b, qwen-token-plan/qwen3.7-plus');
    action(p,t('Models','النماذج'),t('Set chat and agent routes.','اضبط مساري المحادثة والوكيل.'),()=>nativeSettings('models'));
    action(p,t('Super Abdo Mode','وضع سوبر عبدو'),t('Inspect, execute, verify and review work.','افحص ونفّذ وتحقق وراجع العمل.'),()=>nativeSettings('super'));
    action(p,t('Panels & layout','الألواح والتخطيط'),t('Restore or move the sidebar and working panels.','استعد أو حرّك الشريط الجانبي وألواح العمل.'),()=>nativeSettings('layout'));
    prefToggle(p,'classifySessionStates',t('Classify conversation states','تصنيف حالات المحادثات'),t('Show ready, working, completed and needs-input states in the sidebar.','اعرض حالات الجاهزية والعمل والاكتمال والحاجة إلى تدخل في الشريط الجانبي.'),meta.preferences?.classifySessionStates);
    prefSelect(p,'autoArchiveDays',t('Auto-archive inactive conversations','أرشفة المحادثات غير النشطة تلقائيًا'),t('Pinned conversations are never archived automatically.','لا تؤرشف المحادثات المثبتة تلقائيًا.'),meta.preferences?.autoArchiveDays??0,[[0,t('Never','أبدًا')],[7,t('After 7 days','بعد 7 أيام')],[30,t('After 30 days','بعد 30 يومًا')],[90,t('After 90 days','بعد 90 يومًا')]]);
    prefSelect(p,'interfaceFont',t('Interface font','خط الواجهة'),t('Applied immediately to menus, settings and chat chrome.','يطبق فورًا على القوائم والإعدادات وإطار المحادثة.'),meta.preferences?.interfaceFont||'system',[['system',t('System','النظام')],['segoe','Segoe UI'],['cairo','Cairo']]);
    prefText(p,'codeFont',t('Code font','خط الكود'),t('Used by terminal, diffs, code blocks and the file editor.','يستخدم في الطرفية والتغييرات وكتل الكود ومحرر الملفات.'),meta.preferences?.codeFont||'Consolas',value=>!value||/[;{}]/.test(value)?t('Enter a plain installed font name.','أدخل اسم خط مثبتًا دون رموز خاصة.'):'');
    prefSelect(p,'transcriptSize',t('Transcript size','حجم المحادثة'),t('Changes message text without scaling the whole application.','يغير نص الرسائل دون تكبير التطبيق كله.'),meta.preferences?.transcriptSize||'medium',[['small',t('Small','صغير')],['medium',t('Medium','متوسط')],['large',t('Large','كبير')]]);
    prefSelect(p,'transcriptWidth',t('Transcript width','عرض المحادثة'),t('Controls the maximum readable width of the conversation.','يضبط أقصى عرض مريح للمحادثة.'),meta.preferences?.transcriptWidth||'comfortable',[['compact',t('Compact','ضيق')],['comfortable',t('Comfortable','مريح')],['wide',t('Wide','واسع')]]);
    prefSelect(p,'uiDensity',t('Interface density','كثافة الواجهة'),t('Changes spacing in navigation, settings, cards and menus.','تغيّر المسافات في التنقل والإعدادات والبطاقات والقوائم.'),meta.preferences?.uiDensity||'comfortable',[['compact',t('Compact','مدمجة')],['comfortable',t('Comfortable','مريحة')],['spacious',t('Spacious','واسعة')]]);
    prefSelect(p,'accentColor',t('Accent color','لون التمييز'),t('Applied immediately to focus, activity and primary actions.','يطبق فورًا على التركيز والنشاط والإجراءات الأساسية.'),meta.preferences?.accentColor||'gold',[['gold',t('Abdo gold','ذهبي عبدو')],['blue',t('Blue','أزرق')],['violet',t('Violet','بنفسجي')],['emerald',t('Emerald','زمردي')]]);
    prefSelect(p,'codeThemeLight',t('Code theme in light mode','سمة الكود في الوضع الفاتح'),t('Used by terminal, diffs and the source editor.','تستخدم في الطرفية والتغييرات ومحرر المصدر.'),meta.preferences?.codeThemeLight||'abdo-light',[['abdo-light','Abdo Light'],['github-light','GitHub Light'],['solarized-light','Solarized Light']]);
    prefSelect(p,'codeThemeDark',t('Code theme in dark mode','سمة الكود في الوضع الداكن'),t('Used automatically when the application switches to dark mode.','تستخدم تلقائيًا عند انتقال التطبيق للوضع الداكن.'),meta.preferences?.codeThemeDark||'abdo-dark',[['abdo-dark','Abdo Dark'],['github-dark','GitHub Dark'],['monokai','Monokai']]);
    prefText(p,'branchPrefix',t('New branch prefix','بادئة الفروع الجديدة'),t('Pre-fills new branch and worktree dialogs.','تملأ مقدمًا حوارات الفرع ونسخة العمل.'),meta.preferences?.branchPrefix||'abdo/',value=>value.length>40||/\s|\.\.|[~^:?*\[\\]/.test(value)?t('Use a valid short Git branch prefix.','استخدم بادئة فرع Git قصيرة وصالحة.'):'');
    prefToggle(p,'draftPullRequests',t('Draft pull requests','طلبات الدمج كمسودة'),t('Labels repository compare links as draft review work.','يعرض روابط مقارنة المستودع كعمل مراجعة مسودة.'),meta.preferences?.draftPullRequests);

    p=addPanel('nss-cowork',t('Cowork','العمل المشترك'));
    summary(p,t('Projects and routines live in the native workspace store. Routines run only while this desktop app and its local engine are available.','توجد المشاريع والروتينات في مخزن مساحة العمل الأصلي. لا تعمل الروتينات إلا أثناء توفر تطبيق سطح المكتب ومحركه المحلي.'));
    fact(p,t('Saved project folders','مجلدات المشاريع المحفوظة'),(meta.projects||[]).length);fact(p,t('Routines','الروتينات'),(meta.schedules||[]).length);
    action(p,t('Manage project folders','إدارة مجلدات المشاريع'),t('Saved folders require the engine trust approval before they can be used as trusted workspaces.','تحتاج المجلدات المحفوظة موافقة توثيق المحرك قبل استخدامها كمساحات عمل موثّقة.'),()=>go('projects'));
    action(p,t('Manage routines','إدارة الروتينات'),t('Review schedules and their last recorded run.','راجع الجداول وآخر تشغيل مسجل.'),()=>go('routines'));

    p=addPanel('nss-chrome',t('Abdo in Chrome','عبدو في كروم'));
    summary(p,t('Use the docked viewer for manual browsing or connect the isolated controlled Edge browser to the agent. Each has its own measured state.','استخدم العارض المثبت للتصفح اليدوي أو صِل متصفح Edge المعزول القابل للتحكم بالوكيل. لكل منهما حالته المقاسة.'));
    fact(p,t('Built-in browser panel','لوحة المتصفح المدمجة'),shell.showBrowserPane===false?t('Hidden','مخفية'):t('Available','متاحة'));
    action(p,t('Open built-in browser','فتح المتصفح المدمج'),t('Use the local browser panel without claiming a Chrome connection.','استخدم لوحة المتصفح المحلية دون ادعاء اتصال بكروم.'),()=>{closeSettings();$('browsertab')?.click();});
    prefToggle(p,'openLinksInBuiltin',t('Open links in the built-in browser','فتح الروابط في المتصفح المدمج'),t('Project links use the docked browser when it is available.','تستخدم روابط المشروع المتصفح المثبت داخل مساحة العمل عند توفره.'),meta.preferences?.openLinksInBuiltin);
    prefSelect(p,'browserDefaultPermission',t('Default site permission','الإذن الافتراضي للمواقع'),t('Block prevents navigation until you change this setting.','المنع يوقف التنقل حتى تغيّر هذا الإعداد.'),meta.preferences?.browserDefaultPermission||'allow',[['allow',t('Allow sites except blocked list','السماح عدا قائمة الحظر')],['block',t('Block all sites','حظر كل المواقع')]]);
    prefSelect(p,'browserPersistence',t('Browser session storage','تخزين جلسة المتصفح'),t('Session isolates browser state when supported; shared keeps the local pane profile.','تعزل الجلسة حالة المتصفح عند الدعم؛ والمشتركة تحفظ ملف اللوحة المحلي.'),meta.preferences?.browserPersistence||'session',[['session',t('Per app session','لكل جلسة تطبيق')],['shared',t('Shared local profile','ملف محلي مشترك')]]);
    const blocked=node('label','nss-pref-row nss-pref-wide');const blockedCopy=node('span');blockedCopy.append(node('strong','',t('Blocked sites','المواقع المحظورة')),node('small','',t('One domain per line, such as example.com. Subdomains are blocked too.','نطاق واحد في كل سطر مثل example.com، وتحظر نطاقاته الفرعية أيضًا.')));const blockedInput=node('textarea');blockedInput.dir='ltr';blockedInput.rows=4;blockedInput.value=(meta.preferences?.blockedSites||[]).join('\n');const blockedSave=node('button','nss-action',t('Save list','حفظ القائمة'));blockedSave.type='button';blockedSave.onclick=()=>{const values=[...new Set(blockedInput.value.split(/\s+/).map(x=>x.trim().toLowerCase()).filter(Boolean))];if(values.some(x=>!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))){api.bridge.notice?.(t('Use domain names only, without protocols or paths.','استخدم أسماء نطاقات فقط دون بروتوكول أو مسار.'));return;}setPreference('blockedSites',values);};blocked.append(blockedCopy,blockedInput,blockedSave);p.append(blocked);

    p=addPanel('nss-desktop',t('General desktop settings','إعدادات سطح المكتب العامة'));
    renderDesktop(p,snap);
    p.append(node('h3','nss-subheading',t('Computer use','استخدام الكمبيوتر')));
    summary(p,t('AbdoCode can read and operate the isolated browser surface through named elements and approval gates. Desktop control (screen, windows, mouse, keyboard) is a separate switch below, off by default, and every input action asks for approval.','يستطيع عبدو كود قراءة سطح المتصفح المعزول وتشغيله عبر عناصر مسماة وبوابات الموافقة. والتحكّم بسطح المكتب (الشاشة والنوافذ والماوس والكيبورد) مفتاحٌ مستقلّ أدناه، مطفأٌ افتراضاً، وكلُّ فعلِ إدخالٍ يطلب موافقتك.'));
    const computerUse=node('label','nss-pref-row');const computerCopy=node('span');computerCopy.append(node('strong','',t('Enable browser computer use','تفعيل استخدام متصفح الكمبيوتر')),node('small','',t('Allows page reading, navigation, trusted clicks and non-credential text entry.','يسمح بقراءة الصفحة والتنقل والنقرات الموثوقة وكتابة النصوص غير السرية.')));const computerToggle=node('input');computerToggle.type='checkbox';computerToggle.checked=runtime.computerUseEnabled!==false;computerToggle.onchange=async()=>{computerToggle.disabled=true;try{await api.applyRuntimeSettings({computerUseEnabled:computerToggle.checked});api.bridge.notice?.(t('Computer use setting applied.','طُبق إعداد استخدام الكمبيوتر.'));}catch(error){computerToggle.checked=!computerToggle.checked;api.bridge.notice?.(t('Could not apply computer use setting: ','تعذر تطبيق إعداد استخدام الكمبيوتر: ')+String(error));}finally{computerToggle.disabled=false;}};computerUse.append(computerCopy,computerToggle);p.append(computerUse);
    // ب6 — تحكّمُ سطح المكتب: مفتاحٌ مستقلّ (يغيّر سلوكاً خارج المتصفّح) — الأداةُ desk في المحرّك ترفض حين يكون مطفأً.
    const deskUse=node('label','nss-pref-row');const deskCopy=node('span');deskCopy.append(node('strong','',t('Enable desktop control (computer use on Windows)','تفعيل تحكّم سطح المكتب (كومبيوتر-يوس على ويندوز)')),node('small','',t('Screenshots to your vision model, window list and focus, clicks, typing, keys and scrolling — each input action asks for approval. Nothing is typed or clicked until a window is focused by name, and the action is cancelled if that window is not in front at that instant. Screenshots capture the focused window alone unless you ask for the whole screen. Off by default.','لقطاتٌ إلى نموذج الرؤية، قائمةُ النوافذ وتركيزُها، نقرٌ وكتابةٌ ومفاتيحُ وتمرير — كلُّ فعلِ إدخالٍ يطلب موافقتك، ولا يُكتب حرفٌ ولا تقع نقرةٌ قبل تركيز نافذةٍ بالاسم، ويُلغى الفعلُ إن لم تكن هي المقدّمةَ لحظتَه. واللقطةُ للنافذة المركَّزة وحدها ما لم تطلب الشاشةَ كلَّها. مطفأٌ افتراضاً.')));const deskToggle=node('input');deskToggle.type='checkbox';deskToggle.checked=runtime.desktopControlEnabled===true;deskToggle.onchange=async()=>{deskToggle.disabled=true;try{await api.applyRuntimeSettings({desktopControlEnabled:deskToggle.checked});api.bridge.notice?.(t('Desktop control setting applied.','طُبق إعداد تحكّم سطح المكتب.'));}catch(error){deskToggle.checked=!deskToggle.checked;api.bridge.notice?.(String(error));}finally{deskToggle.disabled=false;}};deskUse.append(deskCopy,deskToggle);p.append(deskUse);
    const backendRow=node('label','nss-pref-row');const backendCopy=node('span');backendCopy.append(node('strong','',t('Agent browser','متصفّح الوكيل')),node('small','',t('Lightweight owned browser (Edge via CDP, isolated profile) — or your real browser through the AbdoCode extension (Chrome, Edge, Firefox): pair it under Connections ▸ Browser extension ▸ Connect. Off stops every browser tool. From chat: «browser owned | extension | off | status».','المتصفّح الخفيف المملوك (Edge عبر CDP بملفٍّ معزول) — أو متصفّحك الحقيقيّ عبر إضافة عبدو كود (كروم، إيدج، فايرفوكس): اقرنه من الاتّصالات ▸ إضافة المتصفّح ▸ وصّل. «إيقاف» يوقف أدوات المتصفّح كلَّها. من الشات: «browser owned | extension | off | status».')));const backendSelect=node('select');for(const [id,text] of [['owned',t('Lightweight owned browser (Edge)','المتصفّح الخفيف المملوك (Edge)')],['extension',t('My browser via the extension (Chrome / Edge / Firefox)','متصفّحي عبر الإضافة (كروم / إيدج / فايرفوكس)')],['off',t('Off','إيقاف')]]){const option=node('option','',text);option.value=id;backendSelect.append(option);}backendSelect.value=runtime.browserBackend||'owned';backendSelect.onchange=async()=>{backendSelect.disabled=true;try{await api.applyRuntimeSettings({browserBackend:backendSelect.value});api.bridge.notice?.(t('Agent browser setting applied.','طُبق إعداد متصفّح الوكيل.'));}catch(error){backendSelect.value=runtime.browserBackend||'owned';api.bridge.notice?.(String(error));}finally{backendSelect.disabled=false;}};backendRow.append(backendCopy,backendSelect);p.append(backendRow);
    fact(p,t('Controllable surface','السطح القابل للتحكم'),t('Controlled Edge session. The built-in panel supports manual browsing.','جلسة Edge يتحكم بها الوكيل. اللوحة المدمجة تدعم التصفح اليدوي.'));

    p=addPanel('nss-extensions',t('Extensions','الامتدادات'));
    summary(p,t('Import a local SKILL.md folder or an abdocode-extension.json bundle, review its contents, then enable it explicitly. Installed MCP servers connect only when you start them.','استورد مجلد SKILL.md محليًا أو حزمة abdocode-extension.json، وراجع محتوياتها، ثم فعّلها صراحة. لا تتصل خوادم MCP المثبتة إلا عند تشغيلها.'));
    fact(p,t('MCP configurations','إعدادات MCP'),configured.length);fact(p,t('Engine capabilities','إمكانات المحرك'),registry?.descriptors?.length??t('Waiting for engine','بانتظار المحرك'));
    action(p,t('Configure MCP servers','ضبط خوادم MCP'),t('Review bundled entries or add a command you trust.','راجع العناصر المضمنة أو أضف أمرًا تثق به.'),()=>nativeSettings('connections'));
    action(p,t('Open directory','فتح الدليل'),t('Browse what is present in this native build.','تصفح ما هو موجود في هذا الإصدار الأصلي.'),()=>openDirectory('connectors'));

    p=addPanel('nss-remote',t('Abdo Remote Control','عبدو ريموت كونترول'));
    summary(p,t('Open this session from your phone on the same Wi-Fi: turn it on, open the address in the phone browser, enter the six-digit code. The phone sees the live turn, can send a prompt, interrupt, and answer approvals. Nothing leaves your network; settings and providers cannot be changed remotely.','افتح هذه الجلسة من هاتفك على شبكة الواي فاي نفسها: فعّل، افتح العنوان في متصفّح الهاتف، وأدخل رمز الاقتران المكوّن من ستّة أرقام. يرى الهاتفُ الدور الحيّ ويرسل طلباً ويقطع ويجيب الموافقات. لا شيء يغادر شبكتك، ولا تُغيَّر الإعدادات ولا المزوّدون من بعيد.'));
    {const row=node('label','nss-pref-row');const copy=node('span');copy.append(node('strong','',t('Remote control','الريموت كونترول')),node('small','',t('Off by default. Turning it off disconnects every phone and revokes its pairing.','مطفأ افتراضاً. إطفاؤه يفصل كلّ هاتف ويُبطل اقترانه.')));const input=node('input');input.type='checkbox';input.checked=runtime.remoteControlEnabled===true;input.setAttribute('aria-label',t('Remote control','الريموت كونترول'));
      input.onchange=async()=>{input.disabled=true;try{await api.applyRuntimeSettings({remoteControlEnabled:input.checked});api.bridge.notice?.(input.checked?t('Remote control is on — pair your phone with the code below.','الريموت مفعَّل — اقرن هاتفك بالرمز أدناه.'):t('Remote control is off.','أُطفئ الريموت.'));}catch(e){input.checked=!input.checked;api.bridge.notice?.(t('Could not change remote control: ','تعذر تغيير الريموت: ')+String(e));}finally{input.disabled=false;}};row.append(copy,input);p.append(row);}
    if(remoteStatus?.status==='on'){
      fact(p,t('Phone address','عنوان الهاتف'),(remoteStatus.urls||[]).join('  |  ')||t('No network address found','لا عنوان شبكة'),t('Type it in the phone browser (same Wi-Fi).','اكتبه في متصفّح الهاتف (الواي فاي نفسه).'));
      fact(p,t('Pairing code','رمز الاقتران'),remoteStatus.code||'—',t('Consumed by one successful pairing; rotates after five wrong tries.','يُستهلك باقترانٍ واحد ناجح؛ يتبدّل بعد خمس محاولات خاطئة.'));
      fact(p,t('Connected phones','الهواتف المتّصلة'),`${remoteStatus.clients??0} / ${remoteStatus.devices??0} ${t('paired','مقترنة')}`);
      action(p,t('New pairing code','رمز اقتران جديد'),t('Invalidates the shown code; paired phones stay connected.','يُبطل الرمز المعروض؛ الهواتف المقترنة تبقى.'),()=>{api.bridge.send?.({kind:'remote-control-regenerate'});});
      action(p,t('Refresh status','تحديث الحالة'),t('Re-reads the address, code and client count from the engine.','يعيد قراءة العنوان والرمز وعدد العملاء من المحرّك.'),()=>{api.bridge.send?.({kind:'remote-control-get'});});
    } else if(runtime.remoteControlEnabled===true){
      fact(p,t('Status','الحالة'),t('Starting…','يبدأ…'));action(p,t('Refresh status','تحديث الحالة'),'',()=>{api.bridge.send?.({kind:'remote-control-get'});});
    } else fact(p,t('Status','الحالة'),t('Off','مطفأ'));

    p=addPanel('nss-developer',t('Developer','المطوّر'));
    summary(p,t('Inspect the authenticated local engine, network execution boundary and MCP commands configured for this workspace.','اعرض المحرك المحلي المصادق عليه وحد التنفيذ الشبكي وأوامر MCP المضبوطة لمساحة العمل.'));
    fact(p,t('Engine channel','قناة المحرك'),snap.engineUp?t('Local and authenticated','محلية ومصادق عليها'):t('Disconnected','غير متصلة'));
    fact(p,t('Project path','مسار المشروع'),snap.project||t('No project','لا مشروع'));
    action(p,t('Runtime & security','التشغيل والأمان'),t('Follow-up, errors and permission sound.','المتابعة والأخطاء وصوت الصلاحية.'),()=>nativeSettings('runtime'));
    action(p,t('Local MCP servers','خوادم MCP المحلية'),t(`${configured.length} saved configuration(s)`,`${configured.length} إعدادات محفوظة`),()=>nativeSettings('connections'));

    p=addPanel('nss-api',t('API keys','مفاتيح API'));
    summary(p,t('API keys are stored in the native vault. This page never reads their values back into the interface.','تُحفظ مفاتيح API في الخزنة الأصلية. لا تقرأ هذه الصفحة قيمها مرة أخرى إلى الواجهة.'));
    fact(p,t('Custom providers','المزوّدون المخصصون'),custom.length);fact(p,t('Selected model','النموذج المحدد'),(api.state.shellMode==='chat'?runtime.chatModel:runtime.agentModel)||runtime.model||api.bridge.providers.DEFAULT_MODEL);
    action(p,t('Provider vault','خزنة المزوّدين'),t('Add or replace credentials and configure compatible endpoints.','أضف بيانات الاعتماد أو استبدلها واضبط نقاط النهاية المتوافقة.'),()=>nativeSettings('providers'),'primary');
    document.dispatchEvent(new CustomEvent('abdocode:settings-rendered'));
  }

  const SKILLS = () => [
    {title:t('Project agents','وكلاء المشروع'),detail:t('List agents registered by the current project and engine.','اعرض الوكلاء المسجلين بواسطة المشروع والمحرك الحالي.'),action:t('Open','فتح'),run:()=>{closeDirectory();closeSettings();api.showPage('session');api.bridge.submit('agents');}},
    {title:t('Documentation','الوثائق'),detail:t('Open the documentation provided by the current project.','افتح الوثائق التي يوفرها المشروع الحالي.'),action:t('Open','فتح'),run:()=>{closeDirectory();closeSettings();api.showPage('session');api.bridge.submit('docs');}},
    {title:t('Memory & awareness','الذاكرة والوعي'),detail:t('Inspect memory owned by the local engine.','اعرض الذاكرة التي يديرها المحرك المحلي.'),action:t('Configure','ضبط'),run:()=>{closeDirectory();nativeSettings('memory');}},
    {title:t('Super Abdo Mode','وضع سوبر عبدو'),detail:t('Verification and independent review for agent work.','التحقق والمراجعة المستقلة لعمل الوكيل.'),action:t('Configure','ضبط'),run:()=>{closeDirectory();nativeSettings('super');}}
  ];
  function builtinDirectoryItems(tab) {
    const snap=snapshot();
    if(tab==='skills') return SKILLS();
    if(tab==='connectors') return (snap.settings?.mcpServers||[]).map(server=>({title:server.id,detail:t('Configured MCP server. It connects only when explicitly started for a session.','خادم MCP مضبوط. لا يتصل إلا عند تشغيله صراحة لهذه الجلسة.'),state:t('Configured','مضبوط'),action:t('Manage','إدارة'),run:()=>{closeDirectory();nativeSettings('connections');},user:true}));
    const registry=snap.pluginRegistry;
    if(!Array.isArray(registry?.descriptors))return [];
    return registry.descriptors.map(d=>({title:d.label||d.name,detail:d.description||t('Registered engine capability.','إمكانات مسجلة في المحرك.'),state:registry.effective?.[d.name]?t('Enabled','مفعّلة'):t('Disabled','معطلة'),action:t('Configure','ضبط'),run:()=>{closeDirectory();nativeSettings('plugins');}}));
  }
  function closeDirectory(){directory?.remove();directory=undefined;}
  function directoryItems(tab){return builtinDirectoryItems(tab).concat((api.localExtensions?.directoryItems(tab)||[]).map(item=>({...item,run:()=>{closeDirectory();item.run();}})));}
  function openDirectory(tab='skills') {
    directoryTab=tab; closeDirectory(); directory=node('div','nss-directory-backdrop');
    const modal=node('section','nss-directory');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label',t('Directory','الدليل'));
    const side=node('aside','nss-directory-side');side.append(node('h2','',t('Directory','الدليل')));
    const main=node('main','nss-directory-main');const top=node('div','nss-directory-top');const close=node('button','nss-directory-close','×');close.type='button';close.setAttribute('aria-label',t('Close directory','إغلاق الدليل'));close.onclick=closeDirectory;
    const searchBox=node('input','nss-directory-search');searchBox.type='search';searchBox.placeholder=t('Search directory…','ابحث في الدليل…');
    const filter=node('select','nss-directory-filter');for(const [v,label] of [['all',t('All','الكل')],['enabled',t('Enabled / configured','مفعّل / مضبوط')]]){const o=node('option','',label);o.value=v;filter.append(o);}
    const sort=node('select','nss-directory-sort');for(const [v,label]of[['name',t('Sort by name','رتّب بالاسم')],['state',t('Sort by status','رتّب بالحالة')]]){const o=node('option','',label);o.value=v;sort.append(o);}
    const grid=node('div','nss-directory-grid');
    function draw() {
      let items=directoryItems(directoryTab);const q=searchBox.value.trim().toLowerCase();if(q)items=items.filter(x=>`${x.title} ${x.detail}`.toLowerCase().includes(q));
      if(filter.value==='enabled')items=items.filter(x=>!x.state||x.state===t('Enabled','مفعّلة')||x.state===t('Configured','مضبوط'));
      items.sort((a,b)=>sort.value==='state'?String(a.state||'').localeCompare(String(b.state||'')):String(a.title).localeCompare(String(b.title)));
      grid.replaceChildren();
      if(!items.length){const empty=node('div','nss-directory-empty');empty.append(node('strong','',directoryTab==='connectors'?t('No MCP server is configured','لا يوجد خادم MCP مضبوط'):t('Nothing is available yet','لا توجد عناصر متاحة بعد')));empty.append(node('p','',directoryTab==='connectors'?t('Use Connectors to review bundled servers or add one explicitly.','استخدم الموصلات لمراجعة الخوادم المضمنة أو إضافة واحد صراحة.'):t('The local engine has not reported this directory.','لم يبلغ المحرك المحلي عن هذا الدليل.')));const b=node('button','nss-card-action',t('Configure','ضبط'));b.onclick=()=>{closeDirectory();nativeSettings(directoryTab==='connectors'?'connections':'plugins');};empty.append(b);grid.append(empty);return;}
      for(const item of items){const card=node('article','nss-directory-card');const head=node('div','nss-card-head');const mark=node('span','nss-card-mark');mark.innerHTML=icon(directoryTab==='connectors'?'connectors':directoryTab==='plugins'?'plugins':'skills');const title=item.user?protect(node('strong','',item.title)):node('strong','',item.title);head.append(mark,title);if(item.state)head.append(node('span','nss-status',item.state));const detail=item.user?protect(node('p','',item.detail)):node('p','',item.detail);const b=node('button','nss-card-action',item.action);b.type='button';b.onclick=item.run;card.append(head,detail,b);grid.append(card);}
    }
    for(const [id,label,image]of[['skills',t('Skills','المهارات'),'skills'],['connectors',t('Connectors','الموصلات'),'connectors'],['plugins',t('Plugins','الإضافات'),'plugins']]){const b=node('button','nss-directory-tab');b.type='button';b.dataset.tab=id;b.innerHTML=icon(image);b.append(document.createTextNode(label));b.classList.toggle('active',id===directoryTab);b.onclick=()=>{directoryTab=id;side.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x.dataset.tab===id));draw();};side.append(b);}
    top.append(searchBox,filter,sort,close);main.append(top,grid);modal.append(side,main);directory.append(modal);document.body.append(directory);
    searchBox.oninput=draw;filter.onchange=draw;sort.onchange=draw;directory.onclick=e=>{if(e.target===directory)closeDirectory();};directory.onkeydown=e=>{if(e.key==='Escape')closeDirectory();};draw();searchBox.focus();
  }

  function refresh(){renderPanels();if(directory)openDirectory(directoryTab);}
  function settingsApplied(next){lang=next?.language==='ar'?'ar':'en';search.placeholder=t('Search settings','ابحث في الإعدادات');search.setAttribute('aria-label',search.placeholder);buildNav();refresh();}
  function frame(f){if(f?.kind==='remote-control'){remoteStatus=f;refresh();return;}if(f?.kind==='ready'){remoteStatus=null;api.bridge.send?.({kind:'remote-control-get'});}if(['ready','settings','plugins','history','model','model-route'].includes(f?.kind))refresh();}
  buildNav();renderPanels();loadDesktopPreferences();
  return {refresh,frame,settingsApplied,openDirectory,dispose(){closeDirectory();for(const n of addedNav)n.remove();for(const p of addedPanels.values())p.remove();search.remove();for(const b of oldNav.querySelectorAll('.nss-original-nav')){b.hidden=false;b.classList.remove('nss-original-nav');}}};
}
