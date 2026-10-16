// 组件入口：外壳与登录页（app.js 专用）。
//
// 登录页用到：sl-input（用户名/密码）、sl-button、sl-card、sl-alert、sl-icon；
// 外壳用到：sl-drawer（窄屏导航）、sl-dropdown + sl-menu + sl-menu-item（账户菜单）、sl-icon-button（主题/菜单按钮）。
// 登录页与外壳共用同一个入口：登录成功后浏览器已经缓存过这些模块，外壳不会重复请求。
import './core.js';
import '../../vendor/shoelace/components/input/input.js';
import '../../vendor/shoelace/components/card/card.js';
import '../../vendor/shoelace/components/drawer/drawer.js';
import '../../vendor/shoelace/components/dropdown/dropdown.js';
import '../../vendor/shoelace/components/menu/menu.js';
import '../../vendor/shoelace/components/menu-item/menu-item.js';

export {};
