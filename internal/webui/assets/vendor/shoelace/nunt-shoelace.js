// 由 scripts/sync-vendor.ps1 生成，请勿手工编辑。
//
// Shoelace 2.20.1 的本地入口：只加载控制台用到的组件，不引 dist/shoelace.js
//（那个入口会把全部 50+ 组件都拉进来）。setBasePath 让 sl-icon 从本地
// vendor 目录取 SVG，不产生任何外部请求，符合后台 CSP。

import { setBasePath } from './utilities/base-path.js';
import './components/alert/alert.js';
import './components/animation/animation.js';
import './components/badge/badge.js';
import './components/breadcrumb/breadcrumb.js';
import './components/breadcrumb-item/breadcrumb-item.js';
import './components/button/button.js';
import './components/button-group/button-group.js';
import './components/card/card.js';
import './components/checkbox/checkbox.js';
import './components/details/details.js';
import './components/dialog/dialog.js';
import './components/divider/divider.js';
import './components/drawer/drawer.js';
import './components/dropdown/dropdown.js';
import './components/format-bytes/format-bytes.js';
import './components/format-date/format-date.js';
import './components/format-number/format-number.js';
import './components/icon/icon.js';
import './components/icon-button/icon-button.js';
import './components/input/input.js';
import './components/menu/menu.js';
import './components/menu-item/menu-item.js';
import './components/menu-label/menu-label.js';
import './components/mutation-observer/mutation-observer.js';
import './components/option/option.js';
import './components/popup/popup.js';
import './components/progress-bar/progress-bar.js';
import './components/radio/radio.js';
import './components/radio-group/radio-group.js';
import './components/relative-time/relative-time.js';
import './components/resize-observer/resize-observer.js';
import './components/select/select.js';
import './components/skeleton/skeleton.js';
import './components/spinner/spinner.js';
import './components/switch/switch.js';
import './components/tab/tab.js';
import './components/tab-group/tab-group.js';
import './components/tab-panel/tab-panel.js';
import './components/tag/tag.js';
import './components/textarea/textarea.js';
import './components/tooltip/tooltip.js';
import './components/visually-hidden/visually-hidden.js';

setBasePath(new URL('.', import.meta.url).pathname);

export { setBasePath };
