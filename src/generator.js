const {getModels, getEnums, getMetaData} = require("@openactive/data-models");
let fs = require("fs");
let fsExtra = require("fs-extra");
let request = require("sync-request");
let path = require("path");

class Generator {
  generateModelClassFiles (dataModelDirectory, extensions) {
    // Empty output directories
    fsExtra.emptyDirSync(dataModelDirectory + "models");
    fsExtra.emptyDirSync(dataModelDirectory + "enums");

    // Returns the latest version of the models map
    const models = getModels();
    const enumMap = getEnums();
    const namespaces = getMetaData().namespaces;

    // Add all extensions and namespaces first, in case they reference each other
    Object.keys(extensions).forEach((prefix) => {
      let extension = this.getExtension(extensions[prefix].url);
      if (!extension) throw "Error loading extension: " + prefix;

      extensions[prefix].graph = extension["@graph"];
      extension["@context"].forEach((context) => {
        if (typeof context === "object") {
          Object.assign(namespaces, context);
        }
      });
    });

    Object.keys(extensions).forEach((prefix) => {
      let extension = extensions[prefix];
      this.augmentWithExtension(extension.graph, models, extension.url, prefix,
        namespaces);
      this.augmentEnumsWithExtension(extension.graph, enumMap, extension.url,
        prefix,
        namespaces);
    });

    Object.keys(models).forEach((typeName) => {
      let model = models[typeName];
      if (typeName != "undefined") { //ignores "model_list.json" (which appears to be ignored everywhere else)

        let pageName = "models/" + this.getPropNameFromFQP(model.type) + ".cs";
        let pageContent = this.createModelFile(model, models, extensions,
          enumMap);

        console.log("NAME: " + pageName);
        console.log(pageContent);

        fs.writeFile(dataModelDirectory + pageName, pageContent,
          (err) => {
            if (err) {
              return console.log(err);
            }

            console.log("FILE SAVED: " + pageName);
          });
      }
    });

    // Converts the enum map into an array for ease of use
    Object.keys(enumMap).
      filter(typeName => !this.includedInSchema(enumMap[typeName].namespace)).
      forEach((typeName) => {
        let thisEnum = enumMap[typeName];

        let pageName = "enums/" + typeName + ".cs";
        let pageContent = this.createEnumFile(typeName, thisEnum);

        console.log("NAME: " + pageName);
        console.log(pageContent);

        fs.writeFile(dataModelDirectory + pageName, pageContent,
          (err) => {
            if (err) {
              return console.log(err);
            }

            console.log("FILE SAVED: " + pageName);
          });
      });
  }

  augmentWithExtension (
    extModelGraph, models, extensionUrl, extensionPrefix, namespaces) {
    // Add classes first
    extModelGraph.forEach((node) => {
      if (node.type === "Class" && Array.isArray(node.subClassOf) &&
        node.subClassOf[0] != "schema:Enumeration") {
        // Only include subclasses for either OA or schema.org classes
        let subClasses = node.subClassOf.filter(
          prop => models[this.getPropNameFromFQP(prop)] ||
            this.includedInSchema(prop));

        let model = subClasses.length > 0 ? {
            "type": node.id,
            // Include first relevant subClass in list (note this does not currently support multiple inheritance), which is discouraged in OA modelling anyway
            "subClassOf": models[this.getPropNameFromFQP(subClasses[0])] ? "#" +
              this.getPropNameFromFQP(subClasses[0]) : this.expandPrefix(
              subClasses[0],
              false, namespaces),
          } :
          {
            "type": node.id,
          };

        models[this.getPropNameFromFQP(node.id)] = model;
      }
    });

    // Add properties to classes
    extModelGraph.forEach((node) => {
      if (node.type === "Property") {
        let field = {
          "fieldName": this.getPropNameFromFQP(node.id),
          "alternativeTypes": node.rangeIncludes.map(
            type => this.expandPrefix(type, node.isArray, namespaces)),
          "description": [
            node.comment + (node.githubIssue
              ? "\n\nIf you are using this property, please join the discussion at proposal " +
              this.renderGitHubIssueLink(node.githubIssue) + "."
              : ""),
          ],
          "example": node.example,
          "extensionPrefix": extensionPrefix,
        };
        node.domainIncludes.forEach((prop) => {
          let model = models[this.getPropNameFromFQP(prop)];
          if (model) {
            model.extensionFields = model.extensionFields || [];
            model.fields = model.fields || {};
            model.extensionFields.push(field.fieldName);
            model.fields[field.fieldName] = field;
          }
        });
      }
    });
  }

  augmentEnumsWithExtension (
    extModelGraph, enumMap, extensionUrl, extensionPrefix, namespaces) {
    extModelGraph.forEach((node) => {
      if (node.type === "Class" && Array.isArray(node.subClassOf) &&
        node.subClassOf[0] == "schema:Enumeration") {
        enumMap[node.label] = {
          "namespace": namespaces[extensionPrefix],
          "comment": node.comment,
          "values": extModelGraph.filter(n => n.type == node.id).
            map(n => n.label),
          "extensionPrefix": extensionPrefix,
        };
      }
    });
  }

  expandPrefix (prop, isArray, namespaces) {
    if (prop.lastIndexOf(":") > -1) {
      let propNs = prop.substring(0, prop.indexOf(":"));
      let propName = prop.substring(prop.indexOf(":") + 1);
      if (namespaces[propNs]) {
        if (propNs === "oa") {
          return (this.isArray ? "ArrayOf#" : "#") + propName;
        } else {
          return (this.isArray ? "ArrayOf#" : "") + namespaces[propNs] +
            propName;
        }
      } else {
        throw "Namespace not found for '" + prop + "'";
      }
    } else return prop;
  }

  renderGitHubIssueLink (url) {
    let splitUrl = url.split("/");
    let issueNumber = splitUrl[splitUrl.length - 1];
    return "[#" + issueNumber + "](" + url + ")";
  }

  getExtension (extensionUrl) {
    let response = request("GET", extensionUrl,
      {accept: "application/ld+json"});
    if (response && response.statusCode == 200) {
      let body = JSON.parse(response.body);
      return body["@graph"] && body["@context"] ? body : undefined;
    } else {
      return undefined;
    }
  }

  getParentModel (model, models) {
    if (model.subClassOf && model.subClassOf.indexOf("#") == 0) {
      return models[model.subClassOf.substring(1)];
    } else {
      return false;
    }
  }

  getPropertyWithInheritance (prop, model, models) {
    if (model[prop]) return model[prop];

    let parentModel = this.getParentModel(model, models);
    if (parentModel) {
      return this.getPropertyWithInheritance(prop, parentModel, models);
    }

    return null;
  }

  getMergedPropertyWithInheritance (prop, model, models) {
    let thisProp = model[prop] || [];
    let parentModel = this.getParentModel(model, models);
    if (parentModel) {
      return thisProp.concat(
        this.getMergedPropertyWithInheritance(prop, parentModel, models));
    } else {
      return thisProp;
    }
  }

  obsoleteNotInSpecFields (model, models) {
    let augFields = Object.assign({}, model.fields);

    let parentModel = this.getParentModel(model, models);
    if (model.notInSpec && model.notInSpec.length > 0) model.notInSpec.forEach(
      (field) => {
        if (parentModel && parentModel.fields[field]) {
          if (this.getPropNameFromFQP(model.type).toLowerCase() !==
            field.toLowerCase()) { // Cannot have property with same name as type, so do not disinherit here
            augFields[field] = Object.assign({}, parentModel.fields[field]);
            augFields[field].obsolete = true;
          }
        } else {
          throw new Error(
            "notInSpec field \"" + field +
            "\" not found in parent for model \"" +
            model.type + "\"");
        }
      });

    Object.keys(augFields).forEach((field) => {
      let thisField = augFields[field];

      if ((thisField.sameAs && this.includedInSchema(thisField.sameAs)) ||
        (!thisField.sameAs && model.derivedFrom &&
          this.includedInSchema(model.derivedFrom))) {
        thisField.derivedFromSchema = true;
      }

      if (parentModel && parentModel.fields[field]) {
        thisField.override = true;
      }
    });

    return augFields;
  }

  calculateInherits (subClassOf, derivedFrom, model) {
    // Prioritise subClassOf over derivedFrom
    if (subClassOf) {
      let subClassOfName = this.convertToCamelCase(
        this.getPropNameFromFQP(subClassOf));
      if (this.includedInSchema(subClassOf)) {
        return `Schema.NET.${subClassOfName}`;
      } else {
        return `${subClassOfName}`;
      }
    } else if (derivedFrom) {
      let derivedFromName = this.convertToCamelCase(
        this.getPropNameFromFQP(derivedFrom));
      if (this.includedInSchema(derivedFrom)) {
        return `Schema.NET.${derivedFromName}`;
      } else {
        // Note if derived from is outside of schema.org there won't be a base class, but it will still be JSON-LD
        return `Schema.NET.JsonLdObject`;
      }
    } else {
      // In the model everything is one or the other (at a minimum must inherit https://schema.org/Thing)
      throw new Error("No base class specified for: " + model.type);
    }
  }

  compareFields (xField, yField) {
    let x = xField.fieldName.toLowerCase();
    let y = yField.fieldName.toLowerCase();

    const knownPropertyNameOrders = {
      "context": 0,
      "type": 1,
      "id": 2,
      "identifier": 3,
      "title": 4,
      "name": 5,
      "description": 6,
    };

    function compare (nameA, nameB) {
      if (nameA < nameB) {
        return -1;
      }
      if (nameA > nameB) {
        return 1;
      }

      // names must be equal
      return 0;
    }

    if (x === "enddate") {
      x = "startdate1";
    } else if (y === "enddate") {
      y = "startdate1";
    }

    let isXKnown = knownPropertyNameOrders.hasOwnProperty(x);
    let isYKnown = knownPropertyNameOrders.hasOwnProperty(y);
    if (isXKnown && isYKnown) {
      let xIndex = knownPropertyNameOrders[x];
      let yIndex = knownPropertyNameOrders[y];
      return compare(xIndex, yIndex);
    } else if (isXKnown) {
      return -1;
    } else if (isYKnown) {
      return 1;
    } else if (xField.extensionPrefix) {
      return 1;
    } else if (yField.extensionPrefix) {
      return -1;
    }

    return compare(x, y);
  }


  createFullModel (fields, partialModel, models) {
    // Ensure each input prop exists
    let model = {
      requiredFields: this.getPropertyWithInheritance("requiredFields",
        partialModel,
        models) || [],
      requiredOptions: this.getPropertyWithInheritance("requiredOptions",
        partialModel, models) || [],
      recommendedFields: this.getPropertyWithInheritance("recommendedFields",
        partialModel, models) || [],
      extensionFields: this.getMergedPropertyWithInheritance("extensionFields",
        partialModel, models) || [],
    };
    // Get all options that are used in requiredOptions
    let optionSetFields = [];
    model.requiredOptions.forEach((requiredOption) => {
      optionSetFields = optionSetFields.concat(requiredOption.options);
    });
    // Create map of all fields
    let optionalFieldsMap = Object.keys(fields).reduce((map, obj) => {
      map[obj] = true;
      return map;
    }, {});
    // Set all known fields to false
    model.requiredFields.concat(model.recommendedFields).
      concat(model.extensionFields).
      forEach(field => optionalFieldsMap[field] = false);
    // Create array of optional fields
    let optionalFields = Object.keys(optionalFieldsMap).
      filter(field => optionalFieldsMap[field]);

    return {
      requiredFields: this.sortWithIdAndTypeOnTop(model.requiredFields),
      recommendedFields: this.sortWithIdAndTypeOnTop(model.recommendedFields),
      optionalFields: this.sortWithIdAndTypeOnTop(optionalFields),
      extensionFields: this.sortWithIdAndTypeOnTop(model.extensionFields),
      requiredOptions: model.requiredOptions,
    };
  }

  sortWithIdAndTypeOnTop (arr) {
    let firstList = [];
    if (arr.includes("type")) firstList.push("type");
    if (arr.includes("id")) firstList.push("id");
    let remainingList = arr.filter(x => x != "id" && x != "type");
    return firstList.concat(remainingList.sort());
  }

  convertToCamelCase (str) {
    if (str === null || str === undefined) return null;
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  includedInSchema (url) {
    if (!url) return false;
    return url.indexOf("//schema.org") > -1 || url.indexOf("schema:") == 0;
  }
}

export default Generator;