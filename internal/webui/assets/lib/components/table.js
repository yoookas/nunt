// 组件入口：数据表格。
//
// kit 的 NuntTable / NuntPager 本身只用 core 里的东西（sl-icon / sl-button / sl-spinner），
// 单独留一个入口是为了让「表格类页面」有一个语义明确的入口，也方便以后把表格专用的
// 组件（例如 skeleton 占位）挂在这里而不用动页面。
import './core.js';
import '../../vendor/shoelace/components/skeleton/skeleton.js';

export {};
