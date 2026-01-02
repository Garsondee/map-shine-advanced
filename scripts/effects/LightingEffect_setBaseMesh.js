  setBaseMesh(baseMesh, assetBundle) {
    const THREE = window.THREE;
    if (!assetBundle || !assetBundle.masks) return;

    this._baseMesh = baseMesh;

    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');
    this.outdoorsMask = outdoorsData?.texture || null;

    this._rebuildOutdoorsProjection();
  }
