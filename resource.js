var _ = require('underscore'),
    Class = require('class'),
    Authentication = require('./authentication'),
    Authorization = require('./authorization'),
    Cache = require('./cache'),
    Throttling = require('./throttling'),
    Validation = require('./validation');

var NotImplemented = Class.extend({
    init:function () {
    }
});

var Resource = module.exports = Class.extend({
    /**
     * constructor
     */
    init:function () {
        // allowed methods tree, can contain 'get','post','put','delete'
        this.allowed_methods = ['get'];
        // the authentication class to use (default:no authentication)
        this.authentication = new Authentication();
        // the authorization class to use (default: no authorization)
        this.authorization = new Authorization();
        // cache mechanizem ( default:no cache)
        this.cache = new Cache();
        // validation mechanizem (default: no validation)
        this.validation = new Validation();
        // throttling engine (default: no throttling)
        this.throttling = new Throttling();
        // fields uppon filtering is allowed
        this.filtering = {};
        // fields that can be updated/created
        this.update_fields = null;
        // fields which are exposable
        this.fields = null;
        // default quering limit
        this.default_limit = null;
        // max results to return
        this.max_limit = null;
    },

    /**
     * called on GET - /<resource>/:resource_id
     *
     * @param req
     * @param res
     */
    show:function (req, res) {
        var self = this;

        return self.dispatch(req, res, function (req, callback) {
            // get the object by id
            self.cached_get_object(req, req._id, callback);
        });
    },

    /**
     * called on GET - /<resource>/
     *
     * @param req
     * @param res
     */
    index:function (req, res) {
        var self = this;

        return self.dispatch(req, res, function (req, callback) {
            // parse query params
            var filters = self.build_filters(req.query);
            var sorts = self.build_sorts(req.query);
            var offset = Number(req.query['offset'] || 0);
            var limit = Number(req.query['limit'] || self.default_limit || self.settings.DEFAULT_LIMIT);
            limit = Math.min(limit, self.max_limit || self.settings.MAX_LIMIT);
            if (limit <= 0)
                limit = self.max_limit || self.settings.MAX_LIMIT;

            // check if in cache
            var cached_key = self.build_cache_key(req.query);
            self.cache.get(cached_key, function (err, objects) {
                if (err) callback(err);
                else {
                    // if in cache, returns cached results
                    if (objects)
                        callback(null, objects);
                    else
                    //  if not get from DB
                        self.get_objects(req, filters, sorts, limit, offset, function (err, objects) {
                            if (err) callback(err);
                            else {
                                // set in cache. don't wait for response
                                self.cache.set(cached_key, objects, function (err) {
                                });
                                callback(null, objects);
                            }
                        });

                }
            });
        });
    },

    /**
     * called on POST - /<resource>/
     *
     * @param req
     * @param res
     */
    create:function (req, res) {
        var self = this;
        return self.dispatch(req, res, function (req, callback) {
            // get request fields, parse & limit them
            var fields = self.hydrate(req.body);

            // validate object
            self.validation.is_valid(fields, function (err, errors) {
                if (err) callback(err);
                else {
                    if (errors && Object.keys(errors).length > 0) {
                        callback({code:400, message:errors, content:'json'});
                    }
                    else {
                        // save objects
                        self.create_obj(req, fields, function (err, object) {
                            if (err) callback(err);
                            else {
                                // save to cache (no need to wait for response)
                                self.cache.set(self.build_cache_key(object.id), object, function () {
                                });
                                callback(null, object);
                            }
                        });
                    }
                }
            });
        });
    },

    /**
     * called on PUT - /<resource>/:resource_id
     *
     * @param req
     * @param res
     */
    update:function (req, res) {
        var self = this;
        return self.dispatch(req, res, function (req, callback) {
            // get the object by the url id
            self.get_object(req, req._id, function (err, object) {
                if (err) callback(err);
                else {
                    // get request fields, parse & limit them
                    var fields = self.hydrate(req.body);

                    // updates the object with the given fields
                    for (var field in fields) {
                        if (typeof(object.set) == 'function')
                            object.set(field, fields[field]);
                        else
                            object[field] = fields[field];
                    }
                    // validate object
                    self.validation.is_valid(object, function (err, errors) {
                        if (err) callback(err);
                        else {
                            if (errors && Object.keys(errors).length > 0) {
                                callback({code:400, message:errors, content:'json'});
                            }
                            else {
                                // save the modified object
                                self.update_obj(req, object, function (err, object) {
                                    if (err)
                                        callback(err);
                                    else {
                                        // save to cache, this time wait for response
                                        self.cache.set(self.build_cache_key(req._id), object, function (err) {
                                            if (err) callback(err);
                                            else callback(null, object);
                                        });
                                    }
                                });
                            }
                        }
                    });
                }
            });
        });
    },

    /**
     * called on DELETE - /<resource>/:resource_id
     *
     * @param req
     * @param res
     */
    destroy:function (req, res) {
        var self = this;

        return self.dispatch(req, res, function (req, callback) {
            // get the object to delete by the url id
            self.get_object(req, req._id, function (err, object) {
                if (err) callback(err);
                else {
                    // delete the object from DB
                    self.delete_obj(req, object, callback);
                    // delete the object from cache
                    self.cache.set(self.build_cache_key(req._id), null, function () {
                    });
                }
            });
        });
    },

    /**
     * set the entity id on request._id
     *
     * @param req
     * @param id
     * @param fn
     */
    load:function (req, id, fn) {
        req._id = id;
        fn(null, id);
    },

    /*****************************     Error Responses   ******************************************
     *
     */

    /**
     * send unautherized response
     *
     * @param res
     * @param message
     */
    unauthorized:function (res, message) {
        if (message)
            res.send(message, 401);
        else
            res.send(401);
    },

    /**
     * send bad request response
     *
     * @param res
     * @param json
     */
    bad_request:function (res, json) {
        res.json(json, 400);
    },

    /**
     * send internal server error response
     *
     * @param err
     * @param req
     * @param res
     */
    internal_error:function (err, req, res) {
        res.send(err.message || '', 500);
    },

    /*****************************     Help functions   ******************************************
     *
     */

    /**
     * gets the allowed methods object
     */
    get_allowed_methods_tree:function () {
        if (!this.allowed_methods)
            return null;
        if (Array.isArray(this.allowed_methods)) {
            var new_tree = {};
            for (var i = 0; i < this.allowed_methods.length; i++) {
                new_tree[this.allowed_methods[i]] = null;
            }
            this.allowed_methods = new_tree
        }
        return this.allowed_methods;
    },

    /**
     * gets the exposable fields tree
     */
    get_tree:function () {
        if (!this.tree && this.fields) {
            if (Array.isArray(this.fields)) {
                this.tree = {};
                for (var i = 0; i < this.fields.length; i++) {
                    this.tree[this.fields[i]] = null;
                }
            }
            else
                this.tree = this.fields;
        }
        return this.tree;
    },

    /**
     * gets the editable fields tree
     */
    get_update_tree:function () {
        if (!this.update_tree && this.update_fields) {
            if (Array.isArray(this.update_fields)) {
                this.update_tree = {};
                for (var i = 0; i < this.update_fields.length; i++) {
                    this.update_tree[this.update_fields[i]] = null;
                }
            }
            if (typeof(this.update_fields) == 'object')
                this.update_tree = this.update_fields;
        }
        return this.update_tree;
    },

    /**
     * goes over response objects & hide all fields that aren't in this.fields. Turns all objects to basic types (Number,String,Array,Object)
     *
     * @param objs
     */
    full_dehydrate:function (objs) {
        if (typeof(objs) == 'object' && 'meta' in objs && 'objects' in objs) {
            objs.objects = this.dehydrate(objs.objects);
            return objs;
        }
        else
            return this.dehydrate(objs);
    },
    /**
     * same as full_dehydrate
     *
     * @param object
     * @param tree
     */
    dehydrate:function (object, tree) {
        // if an array -> dehydrate each object independently
        if (Array.isArray(object)) {
            var objects = [];
            for (var i = 0; i < object.length; i++) {
                objects.push(this.dehydrate(object[i], tree));
            }
            return objects;
        }
        // if basic type return as is
        if (typeof(object) != 'object')
            return object;

        // parse known types
        if (object instanceof Number)
            return this.dehydrate_number(object);
        if (object instanceof Date)
            return this.dehydrate_date(object);

        // object is a dict {}

        // gets the exposeable fields tree
        if (!tree)
            tree = this.get_tree();
        if (!tree)
            return object;
        var new_object = {};
        for (var field in tree) {
            // recursively dehydrate children
            if (typeof(object.get) == 'function')
                new_object[field] = this.dehydrate(object.get(field), tree[field]);
            else
                new_object[field] = this.dehydrate(object[field], tree[field]);
        }
        return new_object;
    },

    /**
     * parse number
     *
     * @param num
     */
    dehydrate_number:function (num) {
        return Number(num);
    },

    /**
     * parse date
     *
     * @param date
     */
    dehydrate_date:function (date) {
        return Date(date);
    },


    /**
     * converts response basic types object to response string
     *
     * @param req
     * @param res
     * @param object
     * @param status
     */
    deserialize:function (req, res, object, status) {
        // TODO negotiate response content type
        res.json(object, status);
    },

    /**
     * performs all API routeen checks before calling 'func', getting 'func' callback with object, and handles response object
     *
     * @param req
     * @param res
     * @param main_func
     */
    dispatch:function (req, res, main_func) {
        var self = this;
        // check if method is allowed
        var method = req.method.toLowerCase();
        if (!( method in self.get_allowed_methods_tree())) {
            self.unauthorized(res);
            return;
        }
        // check authentication
        self.authentication.is_authenticated(req, function (err, is_auth) {
            if (err)
                self.internal_error(err, req, res);
            else {
                if (!is_auth) {
                    self.unauthorized(res);
                    return;
                }

                // check throttleing
                self.throttling.throttle(self.authentication.get_request_identifier(req), function (err, is_throttle) {
                    if (err) {
                        self.internal_error(err, req, res);
                        return;
                    }
                    if (is_throttle) {
                        self.unauthorized(res);
                        return;
                    }
                    self.authorization.is_authorized(req, function (err, is_auth) {
                        if (err) {
                            self.internal_error(err, req, res);
                            return;
                        }

                        if (!is_auth) {
                            self.unauthorized(res);
                            return;
                        }
                        // main function
                        main_func(req, function (err, response_obj) {
                            if (err) {
                                // error can be with error code
                                if (err.code) {
                                    if (err.code == 500)
                                        self.internal_error(err, req, res);
                                    else if (err.code == 400)
                                        self.bad_request(res, err);
                                    else if (err.code == 401)
                                        self.unauthorized(res, err.message);
                                    else
                                        res.json(err.message, err.code);
                                }
                                else {
                                    // mongoose errors usually
                                    if (err.errors)
                                        self.bad_request(res, err.errors);
                                    self.internal_error(err, req, res);
                                }

                                return;
                            }
                            // dehydrate resopnse object
                            response_obj = self.full_dehydrate(response_obj);
                            var status;
                            switch (method) {
                                case 'get':
                                    status = 200;
                                    break;
                                case 'post':
                                    status = 201;
                                    break;
                                case 'put':
                                    status = 204;
                                    break;
                                case 'delete':
                                    status = 203;
                                    break;
                            }
                            // send response
                            self.deserialize(req, res, response_obj, status);
                        });
                    });

                });

            }

        });
    },

    /**
     * builds filtering objects from query string params
     *
     * @param query
     */
    build_filters:function (query) {
        var filters = {};
        var or_filter = [], nor_filter = [];
        for (var field in query) {

            // check for querying operators
            if (field.split('__')[0] in this.filtering)
                filters[field] = query[field];
            else
                continue;
            // support 'in' query
            if (field.split('__').length > 1 && field.split('__')[1] == 'in')
                filters[field] = query[field].split(',');
            if (field == 'or')
                or_filter = query[field].split(',');
            if (field == 'nor')
                nor_filter = query[field].split(',');
        }
        if (or_filter.length) {
            filters['or'] = [];
            for (var i = 0; i < or_filter.length; i++) {
                if (or_filter[i] in filters) {
                    filters['or'].push(filters[or_filter[i]]);
                    delete filters[or_filter[i]];
                }
            }
        }
        if (nor_filter.length) {
            filters['nor'] = [];
            for (var i = 0; i < nor_filter.length; i++) {
                if (nor_filter[i] in filters) {
                    filters['or'].push(filters[nor_filter[i]]);
                    delete filters[or_filter[i]];
                }
            }
        }
        return filters;
    },

    /**
     * builds the sorting objects from query string params
     *
     * @param query
     */
    build_sorts:function (query) {
        var sorting = query['order_by'];
        if (sorting) {
            sorting = sorting.split(',');
            var sorts = [];
            for (var i = 0; i < sorting.length; i++) {
                var asec = sorting[i][0] != '-';
                if (sorting[i][0] == '-')
                    sorting[i] = sorting[i].substr(1);

                sorts.push({field:sorting[i], type:asec ? 1 : -1});
            }
            return sorts;
        }
        return [];
    },

    /**
     * build cache key from query params
     *
     * @param id_query
     */
    build_cache_key:function (id_query) {
        var key = id_query;
        if (typeof(id_query) == 'object') {
            key = '';
            for (var field in id_query)
                key += field + '=' + id_query[field];

        }
        key = this.path + key;
        return key;
    },

    /**
     * get object with cache wrapping
     *
     * @param req
     * @param id
     * @param callback
     */
    cached_get_object:function (req, id, callback) {
        var self = this;
        // get from cache
        var cache_key = self.build_cache_key(id);
        self.cache.get(cache_key, function (err, object) {
            if (err) {
                callback(err);
                return;
            }
            // if returned from cache return it
            if (object) callback(null, object);
            else
                self.get_object(req, id, function (err, object) {
                    if (err) callback(err);
                    else {
                        self.cache.set(cache_key, object, function () {
                        });
                        callback(null, object);
                    }
                });
        });
    },

    /**
     * parses request body + makes sure only allowed field are passed on (from this.update_fields/this.update_tree)
     *
      * @param object
     * @param tree
     */
    hydrate:function (object, tree) {
        if (Array.isArray(object)) {
            var objects = [];
            for (var i = 0; i < object.length; i++) {
                objects.push(this.hydrate(object[i], tree));
            }
            return objects;
        }
        if (typeof(object) != 'object')
            return object;
        if (!tree)
            tree = this.get_update_tree();
        if (!tree)
            return object;
        var new_object = {};
        for (var field in tree)
            new_object[field] = this.hydrate(object[field], tree[field]);
        return new_object;
    },


    // Methods to implemenet

    /**
     * single object getter. (called on - show,update,delete)
     *
     * @param req
     * @param id
     * @param callback
     */
    get_object:function (req, id, callback) {
        throw new NotImplemented();
    },

    /**
     * multiple object getter. called on  - index
     *
     * @param req
     * @param filters
     * @param sorts
     * @param limit
     * @param offset
     * @param callback
     */
    get_objects:function (req, filters, sorts, limit, offset, callback) {
        throw new NotImplemented();
    },

    /**
     * save new object with fields. called on - create
     *
     * @param req
     * @param fields
     * @param callback
     */
    create_obj:function (req, fields, callback) {
        throw new NotImplemented();
    },

    /**
     * save existing object. called on - update
     *
     * @param req
     * @param object
     * @param callback
     */
    update_obj:function (req, object, callback) {
        throw new NotImplemented();
    },

    /**
     * delete object. called on - delete
     *
     * @param req
     * @param object
     * @param callback
     */
    delete_obj:function (req, object, callback) {
        throw new NotImplemented();
    }

});







