function notImplemented(routeName) {
  return function routeStub(_req, res) {
    res.status(501).json({
      error: "Not implemented yet",
      route: routeName,
    });
  };
}

module.exports = {
  notImplemented,
};
