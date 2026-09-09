/**
 * Правила границ слоёв (ADR-0001).
 * Нарушение = падение сборки, а не замечание на ревью.
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-not-depend-on-infrastructure',
      comment:
        'domain обязан оставаться чистым: без infrastructure, БД и SDK внешних сервисов',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain' },
      to: { path: '(^src/modules/[^/]+/infrastructure|^src/shared/db)' },
    },
    {
      name: 'domain-not-depend-on-application',
      comment: 'domain не знает о слое application',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain' },
      to: { path: '^src/modules/[^/]+/application' },
    },
    {
      name: 'domain-no-external-packages',
      comment: 'domain не зависит от драйверов БД и HTTP-клиентов',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/domain' },
      to: { dependencyTypes: ['npm'], pathNot: '^(zod)$' },
    },
    {
      name: 'application-not-depend-on-infrastructure',
      comment: 'application работает через порты, а не конкретные адаптеры',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application' },
      to: { path: '^src/modules/[^/]+/infrastructure' },
    },
    {
      name: 'api-not-depend-on-infrastructure',
      comment:
        'API работает через порты; конкретные адаптеры подключает composition root',
      severity: 'error',
      from: { path: '^src/api' },
      to: { path: '^src/modules/[^/]+/infrastructure' },
    },
    {
      name: 'api-no-database-access',
      comment: 'API не обращается к PostgreSQL напрямую: ни драйвера, ни shared/db',
      severity: 'error',
      from: { path: '^src/api' },
      to: { path: '(^src/shared/db|^node_modules/pg)' },
    },
    {
      name: 'modules-not-depend-on-api',
      comment: 'домен и приложение не знают о транспортном слое',
      severity: 'error',
      from: { path: '^src/modules' },
      to: { path: '^src/api' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js'] },
  },
};
