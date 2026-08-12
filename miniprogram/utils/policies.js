const REGISTRATION_NOTICE_VERSION = "registration-notice-2026-07-12";
const READER_RULES_VERSION = "reader-rules-v1";

const registrationNotice =
  "《中国医院船》旨在帮助中国少年培养健康管理观念。少年读者注册会员应当使用监护人的微信，一位监护人仅可代表一位少年读者。鉴于少年读者是未成年人，务必请监护人认真填写少年读者的会员信息，填写之后无法更改。为充分保护少年隐私，少年读者会员信息采用最简化原则。少年读者的姓名、性别、民族、照片、声音、指纹、家庭住址、座机号码、银行账号、信用卡号、健康情况、学习情况、家庭情况、学校名称等具体信息一概不注册。注册监护人的手机号码是为了防止密码丢失，注册县域是为了开展排名和奖励，专此说明。";

const registrationRules = [
  {
    number: "01",
    title: "认真阅读，真实表达",
    paragraph:
      "读后感应由少年读者独立思考后完成，可以记录感受和疑问，不抄袭、不代写，也不发布与阅读无关的内容。"
  },
  {
    number: "02",
    title: "友善交流，尊重他人",
    paragraph:
      "不发布侮辱、攻击、歧视、恐吓或其他伤害他人的言论，不传播违法、不良或未经证实的信息。"
  },
  {
    number: "03",
    title: "保护隐私，谨慎分享",
    paragraph:
      "不要在代号、读后感或分享内容中填写真实姓名、学校班级、家庭住址、完整手机号等个人敏感信息。"
  },
  {
    number: "04",
    title: "合理使用成长奖励",
    paragraph:
      "纪念章和红五星用于记录阅读成长，不代表医疗评价或现实权益。不得通过重复提交、虚假内容等方式获取奖励。"
  },
  {
    number: "05",
    title: "监护陪伴，安全使用",
    paragraph:
      "监护人应关注少年读者的账号和分享行为。如发现账号异常或不适宜内容，请停止使用并及时联系项目团队。"
  }
];

module.exports = {
  READER_RULES_VERSION,
  REGISTRATION_NOTICE_VERSION,
  registrationNotice,
  registrationRules
};
