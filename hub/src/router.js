function splitPath(path) {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function createRouter() {
  const routes = [];

  return {
    add(method, pattern, handler) {
      routes.push({
        method: method.toUpperCase(),
        segments: splitPath(pattern),
        handler,
      });
    },

    dispatch(request, env) {
      const url = new URL(request.url);
      const pathSegments = splitPath(url.pathname);
      const method = request.method.toUpperCase();

      for (const route of routes) {
        if (route.method !== method) continue;
        if (route.segments.length !== pathSegments.length) continue;

        const params = {};
        let matched = true;

        for (let i = 0; i < route.segments.length; i++) {
          const routeSegment = route.segments[i];
          const pathSegment = pathSegments[i];

          if (routeSegment.startsWith(":")) {
            params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
          } else if (routeSegment !== pathSegment) {
            matched = false;
            break;
          }
        }

        if (matched) {
          return route.handler(request, env, params);
        }
      }

      return null;
    },
  };
}
