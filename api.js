var express = require('express');
var router = express.Router();


/*Segments the query by number of operators and returns an array of segmented query
splitByOperator(room temperature < 72) = 
translated{
    ['attribute'] => 'room temperature',
    ['operator'] => '<',
    ['value'] => '72'
}

Doesn't work with multiple operators
*/
function splitByOperator(query) {

    translated = {};

    if (query.includes('>=')) {
        splitQuery = query.split('>=')
        translated = { 'attribute': splitQuery[0], 'operator': '>=', 'value': splitQuery[1] };
    } else if (query.includes('<=')) {
        splitQuery = query.split('<=')
        translated = { 'attribute': splitQuery[0], 'operator': '<=', 'value': splitQuery[1] };
    } else if (query.includes('>')) {
        splitQuery = query.split('>')
        translated = { 'attribute': splitQuery[0], 'operator': '>', 'value': splitQuery[1] };
    } else if (query.includes('<')) {
        splitQuery = query.split('<')
        translated = { 'attribute': splitQuery[0], 'operator': '<', 'value': splitQuery[1] };
    } else if (query.includes('=')) {
        splitQuery = query.split('=')
        translated = { 'attribute': splitQuery[0], 'operator': '=', 'value': splitQuery[1] };
    } else {
        translated = { 'attribute': query, 'operator': null, 'value': null };
    }

    return translated

}


/*Separates the query by relevant terms, attributes, and groups:
parseQuery('temp <= 72 and occupied by room-id ') =
parsed{
    'operatorSearchTerms' => ['{attribute: "temp ", operator: "<=", value: " 72 "}, {attribute: " occupied ", operator: null, value: null}]';
    'attributes' => ['room-id'];
    'event' => false
    'attributeValue' =>
}
*/
function parseQuery(query) {

    if (query.includes("event")) {

        parsed = { "event": true }
        
    } else {

        getGroupBy = query.split("by");
        searchTerms = getGroupBy[0].split("and");

        operatorSearchTerms = [];
        for (var index in searchTerms) {
            operatorSearchTerms.push(splitByOperator(searchTerms[index]));
        } 

        attributes = (getGroupBy.length > 1) ? getGroupBy[1].trim().split(',') : null; 
        groupByValue = (getGroupBy.length > 1) ? getGroupBy[1].trim().split('=') : [ null ];
        groupByValue = (groupByValue.length > 1) ? groupByValue[1].trim() : null;
        attributes = (groupByValue != null) ? [getGroupBy[1].trim().split('=')[0]] : attributes

        parsed = { 
            "operatorSearchTerms": operatorSearchTerms, 
            "attributes": attributes,
            "event": false,
            "attributeValue": groupByValue
        }

    }

    return parsed

}

/*Allows MySql queries to be run asynchronously to and from database.
asynDbQuery(db,query1) returns promise that query1 on db completes, or throws error, and allows other queries
to run while query1 is being run*/
function asyncDbQuery(db, q) {

    return new Promise((resolve, reject) => {
        db.query(q, function(error, results, fields) {
            resolve(results);    
        });
    });

}


/*Extracts the event from the user search term and stores it in data, used to create data[] which
functions such as getStreamData inserts to in case there's an event, otherwise data[] is created without the event*/
function getEventData(req, query) {

    var db = req.app.get('db');

    return new Promise((resolve, reject) => {

        var eventName = query.replace('event', '').trim();
        var q = "SELECT event FROM event WHERE event='" + eventName + "';";

        let streams = asyncDbQuery(db, q).then(results => {

            var eventName = results[0]['event'];

            var spawn = req.app.get('spawn').spawn;
            var process = spawn('python3', [__dirname + '/event_vectors/compare_hcdm_vectors.py', eventName]);

            process.stdout.on('data', (data) => {
                var streams = String.fromCharCode.apply(null, data).split('\n');
                var data = [];
                for (var i = 0; i < streams.length; i++) {
                    var row = streams[i].split(',');
                    data.push({
                        'group_name': row[0],
                        'group_val': '',
                        'streams': [ row[0] ],
                        'start': [ row[1] ],
                        'end': [ row[2] ]
                    });
                }
                resolve(data);
            });

            process.stderr.on('data', (data) => {
                console.log(String.fromCharCode.apply(null, data));
            });

        });

    });

}

/*Queries stream from attribute_data based on attribute, operator, and value
Separates into categories 'group_name','group_val','streams' in data[]

If user search term is 'temp < 72',
parseQuery('temp < 72') ] returns
parsed = { 
    "operatorSearchTerms": [{attribute: "temp ", operator: "<", value: " 72 "}], 
    "attributes": null,
    "event": false,
    "attributeValue": null
}
var operatorSearchTerms = parsed["operatorSearchTerms"];
var attribute = operatorSearchTerms[oidx]['attribute'];
var operator = operatorSearchTerms[oidx]['operator'];
var value = operatorSearchTerms[oidx]['value'];
getStreamData(db,attribute,operator,value) will return promise that  data['streams'] contains the relevant streams from attribute_data which correspond to attribute 'temp', operator '<', and value '72'

Generally used in tandem with parseQuery(query)
If user search term requires grouping, use getGroupedStreamData(db, attribute, operator, value, groupBy)
*/
function getStreamData(db, attribute, operator, value) {
    
    return new Promise((resolve, reject) => {

        if (operator === null) { var q = "SELECT DISTINCT stream FROM attribute_data WHERE match(attribute_text) against('" + attribute + "');"; }
        else { 
            var q = "SELECT a.name AS stream FROM stream_data AS a, ( SELECT a.stream, a.timestamp FROM max_timestamps AS a, ( select DISTINCT stream FROM attribute_data WHERE match(attribute_text) against('" + attribute + "')) AS b WHERE a.stream=b.stream) AS b WHERE a.name=b.stream AND a.timestamp=b.timestamp AND a.value " + operator + " " + value + ";";
        }

        var data = []; 
        let streams = asyncDbQuery(db, q).then(streams => { 

            for (var i = 0; i < streams.length; i++ ) { 
                data.push({ 
                    'group_name': streams[i]['stream'], 
                    'group_val': '',
                    'streams': [ streams[i]['stream'] ]
                });
            }

            resolve(data);

        });

    });

}

/*Similar to function getStreamData(db, attribute, operator, value), with the addition of grouping the streams
by value groupBy which handles parsed['attributeValue']

getGroupedStreamData('temp < 72 by room-id') is identical to getStreamData('temp < 72') except the returned data is grouped by room-id*/
function getGroupedStreamData(db, attribute, operator, value, groupBy) {

    return new Promise((resolve, reject) => {

        if (operator === null) { var q = "SELECT value, GROUP_CONCAT(DISTINCT stream) as stream FROM (SELECT b.value, a.stream FROM attribute_data AS a, attribute_data AS b WHERE a.stream=b.stream AND match(a.attribute_text) against('" + attribute.trim() + "') AND b.attribute='"+ groupBy.trim() + "' ) as a GROUP BY value;"; } 
        else { 
            var q = "SELECT value, GROUP_CONCAT(DISTINCT stream) AS stream FROM ( SELECT a.stream, a.value FROM attribute_data as a, ( SELECT a.name, a.value FROM stream_data as a, ( SELECT a.stream as name, a.timestamp FROM max_timestamps as a, ( SELECT value as group_name, stream FROM ( SELECT b.value, a.stream FROM attribute_data AS a, attribute_data AS b WHERE a.stream=b.stream AND match(a.attribute_text) against('" +attribute + "') AND b.attribute='" + groupBy + "') as a ) as b WHERE a.stream = b.stream ) as b WHERE a.name = b.name AND a.timestamp = b.timestamp AND value " + operator + " " + value + ") as b WHERE a.stream = b.name AND a.attribute ='" + groupBy + "') as a GROUP BY value ;";
        }

        var data = []; 
        let streams = asyncDbQuery(db, q).then(streams => {

            for (var i = 0; i < streams.length; i++) {
                data.push({
                    'group_name': groupBy,
                    'group_val': streams[i]['value'],
                    'streams': streams[i]['stream'].split(',')
                });
            }

            resolve(data);

        });

    });

}

/*Similar to function getGroupedStreamData(db, attribute, operator, value), with the addition of groupByValue
which handles parsed[attributeValue].

getGroupedValueStreamData('temp < 72 by room-id = 400') is identical to getGroupedStreamData(''temp < 72 by room-id) except the returned data is grouped by room-id which equals 400*/
function getGroupedValueStreamData(db, attribute, operator, value, groupBy, groupByValue) {

    return new Promise((resolve, reject) => {

        if (operator === null) { var q = "SELECT value, GROUP_CONCAT(DISTINCT stream) as stream FROM (SELECT b.value, a.stream FROM attribute_data AS a, attribute_data AS b WHERE a.stream=b.stream AND match(a.attribute_text) against('" + attribute.trim() + "') AND b.attribute='"+ groupBy.trim() + "' and b.value='" + groupByValue.trim() + "' ) AS a GROUP BY value;"; } 
        else { 
            var q = "SELECT value, GROUP_CONCAT(DISTINCT stream) AS stream FROM ( SELECT a.stream, a.value FROM attribute_data as a, ( SELECT a.name, a.value FROM stream_data as a, ( SELECT a.stream as name, a.timestamp FROM max_timestamps as a, ( SELECT value as group_name, stream FROM ( SELECT b.value, a.stream FROM attribute_data AS a, attribute_data AS b WHERE a.stream=b.stream AND match(a.attribute_text) against('" + attribute + "') AND b.attribute='" + groupBy + "') as a ) as b WHERE a.stream = b.stream ) as b WHERE a.name = b.name AND a.timestamp = b.timestamp AND value " + operator + " " + value + ") as b WHERE a.stream = b.name AND a.attribute ='" + groupBy + "' AND a.value='" + groupByValue.trim() + "') AS a GROUP BY value ;";
        }

        console.log(q);

        var data = []; 
        let streams = asyncDbQuery(db, q).then(streams => {

            for (var i = 0; i < streams.length; i++) {
                data.push({
                    'group_name': groupBy,
                    'group_val': streams[i]['value'],
                    'streams': streams[i]['stream'].split(',')
                });
            }

            resolve(data);

        });

    });

}

/*Use this to parse the user's search term, if the user searches 'temp < 72 by room-id = 400',
use router.get('temp < 72 by room-id = 400', async (req, res, next)
*/
router.get('/search/:query', async (req, res, next) => {

    res.header("Access-Control-Allow-Origin", "*");

    var db = req.app.get('db');
    var query = req.params.query; 
    var parsed = parseQuery(query);
    var operatorSearchTerms = parsed["operatorSearchTerms"];
    var attributes = parsed["attributes"];
    var eventRequest = parsed["event"];
    var attributeValue = parsed["attributeValue"];

    if (eventRequest) {

        var data = await getEventData(req, query);

    } else {

        var dictionary = {};
        var keys = [];
        for (var oidx in operatorSearchTerms) {

            var attribute = operatorSearchTerms[oidx]['attribute'];
            var operator = operatorSearchTerms[oidx]['operator'];
            var value = operatorSearchTerms[oidx]['value'];

            if (attributes === null) { 
                var result = await getStreamData(db, attribute, operator, value); 
                for (var ridx in result) {
                    var group_name = result[ridx]['group_name'];
                    if (group_name in dictionary) { dictionary[group_name]['streams'].push.apply(dictionary[group_name]['streams'], result[ridx]['streams']); } 
                    else { dictionary[group_name] = { 'streams': result[ridx]['streams'] }; }
                    keys.push(group_name);
                }
            } else { 
                if (attributeValue === null) {
                    var result = await getGroupedStreamData(db, attribute, operator, value, attributes[0]); 
                    for (var ridx in result) {
                        var group_val = result[ridx]['group_val'];
                        if (group_val in dictionary) { dictionary[group_val]['streams'].push.apply(dictionary[group_val]['streams'], result[ridx]['streams']); }
                        else { dictionary[group_val] = { 'streams': result[ridx]['streams'] };  }
                        keys.push(group_val);
                    }
                } else {
                    var result = await getGroupedValueStreamData(db, attribute, operator, value, attributes[0], attributeValue); 
                    for (var ridx in result) {
                        var group_val = result[ridx]['group_val'];
                        if (group_val in dictionary) { dictionary[group_val]['streams'].push.apply(dictionary[group_val]['streams'], result[ridx]['streams']); }
                        else { dictionary[group_val] = { 'streams': result[ridx]['streams'] };  }
                        keys.push(group_val);
                    }
                }
            }

        }

        var data = [];
        for (var kix in keys) {
            var key = keys[kix];
            if (attributes === null) {
                data.push({
                    'group_name': key,
                    'group_val': '',
                    'streams': dictionary[key]['streams']
                });
            } else {
                data.push({
                    'group_name': attributes[0],
                    'group_val': key,
                    'streams': dictionary[key]['streams']
                });
            }
        }

    }

    res.json(data);
    
});

/*returns streams for a given name*/
router.get('/name/:name', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

	var db = req.app.get('db');
	var name = req.params.name;
	var q = "SELECT * FROM stream_data WHERE name='" + name + "' ORDER BY TIMESTAMP DESC LIMIT 500;"
	db.query(q, function(error, results, fields) { res.json(results); });

});

/*return streams for a given time series, use this for query-by-example and query-by-sketch*/
router.post('/selection', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

	var data = req.body.selectionData;
    var name = data['stream'];
    var start = data['start'];
    var end = data['end'];

    var q = "SELECT * FROM stream_data WHERE name='" + name + "' AND TIMESTAMP >= " + start + " AND TIMESTAMP <= " + end + " ORDER BY TIMESTAMP DESC;";
	var db = req.app.get('db');
	db.query(q, function(error, results, fields) { res.json(results); });

});

/*returns all distinct attributes from db.attribute_data*/
router.get('/attributes', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

	var db = req.app.get('db');
	var q = "SELECT DISTINCT attribute FROM attribute_data;"
	db.query(q, function(error, results, fields) { res.json(results); });

});

router.get('/attributes_by_stream/:stream', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

	var db = req.app.get('db');
	var stream = req.params.stream;
	var q = "SELECT attribute, value FROM attribute_index where stream='" + stream + "';"
	db.query(q, function(error, results, fields) { res.json(results); });

});

//Saves user-inputted alias into the database, affects db.attribute_alias
router.post('/saveAlias', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

    var formData = req.body.formData;
    var attribute = formData['attribute'];
    var text = formData['text'];
    var operator = formData['operator'];
    var value = formData['value'];

    var q = "INSERT INTO attribute_alias (attribute, text, operator, value) VALUES ('" + attribute + "', '" + text + "', '" + operator + "', '" + value + "');";

    var db = req.app.get('db');
	db.query(q, function(err, results, fields) { 
        if (err) { res.send(false); } 
        else { res.send(true); }
    });

});


router.get('/translateQuery/:query', async function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

    var query = req.params.query;
    var parsed = parseQuery(query);

    if (parsed['event']) {

        var newQuery = query;

    } else {

        var operatorSearchTerms = parsed["operatorSearchTerms"];
        var attributes = parsed["attributes"];
        var groupByVal = parsed["attributeValue"];

        var db = req.app.get('db');

        var newQuery = "";
        for (var i in operatorSearchTerms) {

            if (operatorSearchTerms[i]["operator"] === null) { 

                var q = "SELECT * FROM attribute_alias WHERE text='" + operatorSearchTerms[i]["attribute"].trim() + "'";
                var results = await asyncDbQuery(db, q);

                if (results.length > 0) { newQuery += results[0]['attribute'] + " " + results[0]['operator'] + " " + results[0]['value']; }
                else { newQuery += operatorSearchTerms[i]['attribute']; }

            } else { newQuery += operatorSearchTerms[i]['attribute'] + " " + operatorSearchTerms[i]['operator'] + " " + operatorSearchTerms[i]['value']; }

            newQuery += " and ";

        }
        
        newQuery = newQuery.substring(0, newQuery.length - 4);
        if (attributes != null) { newQuery += " by " + attributes; }
        if (groupByVal != null) { newQuery += " = " + groupByVal; }

    }

    res.json({'newQuery': newQuery});

});

//Saves user-inputted event into the database, affects db.event
router.post('/saveEvent', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

    var eventData = req.body.eventData;
    var eventName = eventData['event'];
    var streamName = eventData['stream'];
    var start = Date.parse(eventData['start']) / 1000.0;
    var end = Date.parse(eventData['end']) / 1000.0;

    var spawn = req.app.get('spawn').spawn;
    var process = spawn('python3', [__dirname + '/event_vectors/create_hcdm_vector.py', eventName, streamName, start, end]);

    process.stdout.on('data', (data) => {
        var results = String.fromCharCode.apply(null, data).split(',');
        var features = [];

        results.forEach((result) => {
            if (result.trim()) { features.push(result.replace('\n', '')); }
        });

        var q = "INSERT INTO event VALUES (";

        for (var i = 0; i < 2; i++) { q += "'" + features[i] + "', "; }
        for (var i = 2; i < features.length-1; i++ ) { q += features[i] + ", "; }
        q += features[i] + ");";

        var db = req.app.get('db');
        db.query(q, function(err, results, fields) {
            if (err) { 
                console.log(err);
                res.send(false); 
            }
            else { res.send(true); }
        });

    });

    process.stderr.on('data', (data) => {
        console.log(String.fromCharCode.apply(null, data));
    });

});

//Delete an attribute from the database, affects db.attribute_index
router.post('/deleteAttribute', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

    var attributeData = req.body.attributeData;
    var streamName = attributeData['streamName'];
    var attributeName = attributeData['attributeName'];
    var valueName = attributeData['valueName'];

    var q = "DELETE FROM attribute_index WHERE attribute = '" + attributeName + "' AND stream = '" + streamName + "' AND value = '" + valueName + "';"
    var db = req.app.get('db');
    db.query(q, function(err, results, fields) {
        if (err) { res.send(false); }
        else { res.send(true); }
    });

});

/*Submit an attribute into the database, affects db.attribute_index*/
router.post('/submitAttribute', function(req, res, next) {

    res.header("Access-Control-Allow-Origin", "*");

    var attributeData = req.body.attributeData;
    var streamName = attributeData['streamName'];
    var attributeName = attributeData['attributeName'];
    var valueName = attributeData['valueName'];

    var q = "INSERT INTO attribute_index (attribute, stream, value) VALUES ('" + attributeName + "', '" + streamName + "', '" + valueName + "');";
    var db = req.app.get('db');
    db.query(q, function(err, results, fields) {
        if (err) { res.send(false); }
        else { 
            var q2 = "INSERT INTO attribute_extension(attribute, attribute_text) VALUES ('" + attributeName + "', '" + attributeName + "');";
            db.query(q2, function(err, results, fields) {
                if (err) { res.send(false); }
                else { res.send(true); }
            })
        }
    });

});

module.exports = router;
