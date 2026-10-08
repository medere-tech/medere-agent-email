/** @type {import('next').NextConfig} */
const nextConfig = {
  // instrumentation.ts : préchauffage des données Airtable au démarrage du serveur
  experimental: { instrumentationHook: true },
};

export default nextConfig;
