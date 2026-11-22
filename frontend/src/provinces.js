// Province short names used by the ip2region filters. The backend accepts the
// full forms too ("浙江省", "广西壮族自治区"), but the UI keeps the short form
// so the stored values stay stable.
export const PROVINCES = [
  '北京', '天津', '河北', '山西', '内蒙古',
  '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '重庆', '四川', '贵州', '云南', '西藏',
  '陕西', '甘肃', '青海', '宁夏', '新疆',
  '香港', '澳门', '台湾',
]

export const PROVINCE_OPTIONS = PROVINCES.map((name) => ({ value: name, label: name }))
