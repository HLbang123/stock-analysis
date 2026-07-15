export default function HealthCheckPage() {
  return (
    <div>
      <h1>健康检查</h1>
      <p>时间: {new Date().toLocaleString('zh-CN')}</p>
      <p>状态: 正常运行</p>
    </div>
  );
}