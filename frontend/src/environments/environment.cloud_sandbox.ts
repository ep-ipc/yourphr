export const environment = {
  production: true,
  environment_cloud: true,
  environment_desktop: false,
  environment_name: "sandbox",
  popup_source_auth: false,

  connect_gateway_api_endpoint_base: 'https://lighthouse.fastenhealth.com/sandbox',

  //used to specify the api server that we're going to use (can be relative or absolute). Must not have trailing slash
  fasten_api_endpoint_base: 'https://api.sandbox.fastenhealth.com/v1',

  // NOTE: the SMART OAuth relay is deliberately NOT configured here. redirect_uri is derived by the
  // backend at runtime (relay.public_url / YOURPHR_RELAY_PUBLIC_URL), so a self-hosted relay needs
  // no frontend rebuild (#399).
};
