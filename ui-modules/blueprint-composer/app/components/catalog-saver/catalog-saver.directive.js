/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import angular from 'angular';
import angularAnimate from 'angular-animate';
import uibModal from 'angular-ui-bootstrap/src/modal/index-nocss';
import template from './catalog-saver.template.html';
import modalTemplate from './catalog-saver.modal.template.html';
import jsYaml from 'js-yaml';
import brUtils from 'brooklyn-ui-utils/utils/general';

const MODULE_NAME = 'brooklyn.components.catalog-saver';
const TEMPLATE_URL = 'blueprint-composer/component/catalog-saver/index.html';
const TEMPLATE_MODAL_URL = 'blueprint-composer/component/catalog-saver/modal.html';

const REASONS = {
    new: 0,
    deploy: 1,
    continue: 2,
};
const VIEWS = {
    form: 0,
    saved: 1
};
const TYPES = [
    {id: 'template', label: 'Application'},
    {id: 'entity', label: 'Entity'}
];

// only alphanumerics and/or '.', '-', '_' characters
const VALID_FIELD_PATTERN = /^[\w\.\-\_]+$/;

angular.module(MODULE_NAME, [angularAnimate, uibModal, brUtils])
    .directive('catalogSaver', ['$rootScope', '$uibModal', '$injector', '$filter', 'composerOverrides', 'blueprintService', saveToCatalogModalDirective])
    .directive('catalogVersion', ['$parse', catalogVersionDirective])
    .directive('composerBlueprintNameValidator', composerBlueprintNameValidatorDirective)
    .filter('bundlize', bundlizeProvider)
    .run(['$templateCache', templateCache]);

export default MODULE_NAME;

export function saveToCatalogModalDirective($rootScope, $uibModal, $injector, $filter, composerOverrides, blueprintService) {
    return {
        restrict: 'E',
        templateUrl: function (tElement, tAttrs) {
            return tAttrs.templateUrl || TEMPLATE_URL;
        },
        scope: {
            config: '=',
        },
        link: link
    };

    // TODO We might need to refactor the controller and directive around this to structure it better
    function updateBundleConfig(entity, metadata, config) {
        // the name or can be inherited if root node is a known application type we are editing
        // (normally in those cases $scope.config will already be set by caller, but maybe not always)
        if (!config.name && entity.hasName()) {
            config.name = entity.name;
        }
        // the ID can be set in the UI or can be inherited if root node is a known application type we are editing
        // (normally in those cases $scope.config will already be set by caller, but maybe not always)
        if (!config.symbolicName && (entity.hasId() || metadata.has('id'))) {
            config.symbolicName = entity.id || metadata.get('id');
        }
        if (!config.version && (entity.hasVersion() || metadata.has('version'))) {
            config.version = entity.version || metadata.get('version');
        }
        config.bundle =  config.bundle || config.symbolicName;
    }

    function link($scope, $element) {
        if (!$scope.config.original) {
            // original if provided contains the original metadata, e.g. for use if coming from a template and switching between template and non-template
            $scope.config.original = {}
        }
        $scope.isNewFromTemplate = () => ($scope.config.itemType !== 'template' && $scope.config.original.itemType === 'template');
        $scope.isUpdate = () => !$scope.isNewFromTemplate() && Object.keys($scope.config.original).length>0;
        $scope.buttonTextFn = () => $scope.config.label || ($scope.isUpdate() && ($scope.config.name || $scope.config.original.name || $scope.config.symbolicName || $scope.config.original.symbolicName)) || 'Add to catalog';
        $scope.buttonText = $scope.buttonTextFn();

        $scope.activateModal = () => {
            let entity = blueprintService.get();
            let metadata = blueprintService.entityHasMetadata(entity) ? blueprintService.getEntityMetadata(entity) : new Map();

            if (!$scope.config.itemType) {
                // This is the default item type
                $scope.config.itemType = 'application';
            }

            // Set various properties from the blueprint entity data if not already set
            if (!$scope.config.iconUrl && (entity.hasIcon() || metadata.has('iconUrl'))) {
                $scope.config.iconUrl = entity.icon || metadata.get('iconUrl');
            }
            if (!$scope.isNewFromTemplate()) {
                // (these should only be set if not making something new from a template, as the entity items will refer to the template)
                (composerOverrides.updateBundleConfig || updateBundleConfig)(entity,metadata, $scope.config);
            }

            // Override this callback to update configuration data elsewhere
            $scope.config = (composerOverrides.updateCatalogConfig || ((config, $element) => config))($scope.config, $element);

            const { bundle, symbolicName } = ($scope.config || {});

            $scope.initiallyShowAdvanced = (bundle && symbolicName)
                ? !VALID_FIELD_PATTERN.test(bundle) || !VALID_FIELD_PATTERN.test(symbolicName)
                : false;

            let modalInstance = $uibModal.open({
                templateUrl: TEMPLATE_MODAL_URL,
                size: 'save',
                controller: ['$scope', '$filter', 'blueprintService', 'paletteApi', 'brUtilsGeneral', CatalogItemModalController],
                scope: $scope,
            });

            // Promise is resolved when the modal is closed. We expect the modal to pass back the action to perform thereafter
            modalInstance.result.then(reason => {
                switch (reason) {
                    case REASONS.new:
                        $rootScope.$broadcast('blueprint.reset');
                        break;
                    case REASONS.deploy:
                        $rootScope.$broadcast('blueprint.deploy');
                        break;
                    case REASONS.continue:
                        $rootScope.$broadcast('blueprint.continue');
                        break;
                }
            });
        };
    }
}

export function CatalogItemModalController($scope, $filter, blueprintService, paletteApi, brUtilsGeneral) {
    $scope.REASONS = REASONS;
    $scope.VIEWS = VIEWS;
    $scope.TYPES = TYPES;
    $scope.state = {
        pattern: VALID_FIELD_PATTERN,
        view: VIEWS.form,
        saving: false,
        force: false
    };
    /* Derived properties & calculators, will be updated whenever $scope.state.view changes */
    $scope.getTitle = () => {
        switch ($scope.state.view) {
            case VIEWS.form:
                return $scope.isUpdate() ? `Update ${$scope.config.name || $scope.config.symbolicName || 'blueprint'}` : 'Add to catalog';
            case VIEWS.saved:
                return `${$scope.config.name || $scope.config.symbolicName || 'Blueprint'} ${$scope.isUpdate() ? 'updated' : 'saved'}`;
        }
    };

    $scope.getCatalogURL = () => {
        switch ($scope.state.view) {
            case VIEWS.form:
                return '';
            case VIEWS.saved:
                return `/brooklyn-ui-catalog/#!/bundles/catalog-bom-${$scope.config.catalogBundleId}/${$scope.config.version}/types/${$scope.config.catalogBundleBase}/${$scope.config.version}`;
        }
    };

    $scope.title = $scope.getTitle();
    $scope.catalogURL = $scope.getCatalogURL();

    $scope.$watch('state.view', (newValue, oldValue) => {
        if (newValue !== oldValue) {
            $scope.title = $scope.getTitle();
            $scope.catalogURL = $scope.getCatalogURL();
        }
    });
    /* END Derived properties */

    $scope.save = () => {
        $scope.state.saving = true;
        $scope.state.error = undefined;

        let bom = createBom();
        paletteApi.create(bom, { forceUpdate: $scope.state.force })
            .then((savedItem) => {
                if (!angular.isArray($scope.config.versions)) {
                    $scope.config.versions = [];
                }
                $scope.config.versions.push($scope.config.version);
                $scope.state.view = VIEWS.saved;
            })
            .catch(error => {
                $scope.state.error = error.error.message;
            })
            .finally(() => {
                $scope.state.saving = false;
            });
    };


    function createBom() {
        let blueprint = blueprintService.getAsJson();

        let bundleBase = $scope.config.bundle || $scope.defaultBundle;
        let bundleId = $scope.config.symbolicName || $scope.defaultSymbolicName;
        if (!bundleBase || !bundleId) {
            throw "Either the display name must be set, or the bundle and symbolic name must be explicitly set";
        }

        let bomItem = {
            id: bundleId,
            itemType: $scope.config.itemType,
            item: blueprint
        };
        // tags can now be added to a blueprint created in the YAML Editor
        let tags = [];
        if (blueprint.tags) {
            tags = tags.concat(blueprint.tags);
            delete blueprint['tags'];
        }
        if (blueprint['brooklyn.tags']) {
            tags = [].concat(blueprint['brooklyn.tags']).concat(tags);
        }
        blueprint['brooklyn.tags'] = tags;
        let bomCatalogYaml = {
            bundle: `catalog-bom-${bundleBase}`,
            version: $scope.config.version,
            items: [ bomItem ]
        };
        if(tags) {
            bomCatalogYaml.tags = tags
        }

        let bundleName = $scope.config.name || $scope.defaultName;
        if (brUtilsGeneral.isNonEmpty(bundleName)) {
            bomItem.name = bundleName;
        }
        if (brUtilsGeneral.isNonEmpty($scope.config.description)) {
            bomItem.description = $scope.config.description;
        }
        if (brUtilsGeneral.isNonEmpty($scope.config.iconUrl)) {
            bomItem.iconUrl = $scope.config.iconUrl;
        }
        $scope.config.catalogBundleId = bundleId;
        $scope.config.catalogBundleBase = bundleBase;
        return jsYaml.dump({ 'brooklyn.catalog': bomCatalogYaml });
    }

    let bundlize = $filter('bundlize');
    $scope.updateDefaults = (newName) => {
        $scope.defaultName = ($scope.config.itemType==='template' && $scope.config.original.name) || null;
        $scope.defaultSymbolicName = ($scope.config.itemType==='template' && $scope.config.original.symbolicName) || bundlize(newName) || null;
        $scope.defaultBundle = ($scope.config.itemType==='template' && $scope.config.original.bundle) || bundlize(newName) || null;
    };
    $scope.$watchGroup(['config.name', 'config.itemType', 'config.bundle', 'config.symbolicName'], (newVals) => {
        $scope.updateDefaults(newVals[0]);
        $scope.form.name.$validate();
        $scope.buttonText = $scope.buttonTextFn();
    });
}

function composerBlueprintNameValidatorDirective() {
    return {
        restrict: 'A',
        require: 'ngModel',
        link: function(scope, element, attr, ngModel) {
            ngModel.$validators.composerBlueprintNameValidator = function(modelValue, viewValue) {
                scope.updateDefaults(modelValue);
                if (!ngModel.$isEmpty(modelValue)) {
                    // anything set is valid
                    return true;
                }
                // if not set, we need a bundle and symbolic name
                if (scope.config.bundle && scope.config.symbolicName) {
                    return true;
                }
                // or if we have defaults for bundle and symbolic name we don't need this name
                if (scope.defaultBundle && scope.defaultSymbolicName) {
                    return true;
                }
                return false;
            }
        },
    };
}

export function catalogVersionDirective($parse) {
    return {
        restrict: 'A',
        require: 'ngModel',
        link: link
    };

    function link(scope, elm, attr, ctrl) {
        if (!ctrl) {
            return;
        }

        let matches;
        let force;

        scope.$watch(attr.catalogVersion, value => {
            if (matches !== value) {
                matches = value;
                ctrl.$validate();
            }
        });
        scope.$watch(attr.catalogVersionForce, value => {
            if (force !== value) {
                force = value;
                ctrl.$validate();
            }
        });

        ctrl.$validators.exist = (modelValue, viewValue) => {
            return !angular.isDefined(matches) || ctrl.$isEmpty(viewValue) || viewValue.endsWith('SNAPSHOT') || force === true || matches.indexOf(viewValue) === -1;
        };
    }
}

function templateCache($templateCache) {
    $templateCache.put(TEMPLATE_URL, template);
    $templateCache.put(TEMPLATE_MODAL_URL, modalTemplate);
}

function bundlizeProvider() {
    return (input) => input && input.split(/[^a-zA-Z0-9]+/).filter(x => x).join('-').toLowerCase();
}
