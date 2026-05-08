const express = require('express')
const cors = require('cors');
const app = express()
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// payment stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000
// generate tracking id
const crypto = require('crypto');

// firebase 
const admin = require("firebase-admin");

const serviceAccount = require(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
    const prefix = "PRCL"; // your brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random

    return `${prefix}-${date}-${random}`;
}
// test
console.log(generateTrackingId());

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
    // console.log('headers in the middleware', req.headers.authorization);
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' });
    }

    try {
        const idToken = token.split(' ')[1];    // must white space dite hobe... 
        const decoded = await admin.auth().verifyIdToken(idToken);     // must add
        console.log('decoded in the token : ', decoded);
        req.decoded_email = decoded.email;

        next();
    }
    catch (err) {
        return res.status(401).send({ message: 'unauthorized access' });
    }


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@gampi.pfydvdc.mongodb.net/?appName=Gampi`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db('zap_shift_db');   // create database
        const usersCollection = db.collection('users');
        const parcelsCollection = db.collection('parcels');
        const paymentCollection = db.collection('payments');
        const ridersCollection = db.collection('riders');
        const trackingsCollection = db.collection('trackings');

        // middleware admin before allowing admin activity
        // must be used after verifyFBToken middlware

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        }

        // tracking log
        const logTracking = async (trackingId, status) => {
            const log = {
                trackingId,
                status,
                details: status.split('_').join(' '),
                createdAt: new Date()
            }
            const result = await trackingsCollection.insertOne(log);
            return result;
        }


        // users related apis
        // get users
        app.get('/users', verifyFBToken, async (req, res) => {

            const searchText = req.query.searchText;
            const query = {};

            if (searchText) {
                // query.displayName = { $regex: searchText, $options: 'i' }; // single search by name

                // search by name and email 
                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } }
                ]
            }

            const cursor = usersCollection.find(query).sort({ createAt: - 1 }).limit(5);
            const result = await cursor.toArray();  // userdb teke user k array akare newar jonno
            res.send(result);
        })

        // get users by id
        app.get('/users/:id', async (req, res) => {


        })

        // get users by email with role
        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);

            res.send({ role: user?.role || 'user' });
        })


        // user create
        app.post('/users', async (req, res) => {
            const user = req.body;

            // by default --> user - normal user
            user.role = 'user';
            user.createdAt = new Date();
            const email = user.email;

            const userExists = await usersCollection.findOne({ email });

            if (userExists) {
                return res.send({ message: 'user exists' });
            }

            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        // update user
        app.patch('/users/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await usersCollection.updateOne(query, updateDoc);
            res.send(result);
        })

        // parcel  api
        // get parcel
        app.get('/parcels', async (req, res) => {
            const query = {};
            const { email, deliveryStatus } = req.query;    // exact kono kichu pete cai like email

            // parcels?email='' &
            if (email) {
                query.senderEmail = email;  // sender er email diye sodo matro tar info gulo dekar jonne

            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const options = { sort: { createAt: -1 } }

            const cursor = parcelsCollection.find(query, options);
            const result = await cursor.toArray(cursor);
            res.send(result);
        })

        //get parcel by email for assigned deliveries
        app.get('/parcels/rider', async (req, res) => {
            const { riderEmail, deliveryStatus } = req.query;
            const query = {}    // query must be define


            if (riderEmail) {
                query.riderEmail = riderEmail
            }
            if (deliveryStatus !== 'parcel_delivered') {
                // query.deliveryStatus = {$in: ['driver_assigned', 'rider_arriving']}// status ei gulo takle amk daw
                query.deliveryStatus = { $nin: ['parcel_delivered'] }
            }
            else {
                query.deliveryStatus = deliveryStatus;
            }

            const cursor = parcelsCollection.find(query)
            const result = await cursor.toArray();
            res.send(result);
        })


        // get data by id wise          // je data ta pay korte cacci setar data dorkar
        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const result = await parcelsCollection.findOne(query);
            res.send(result);

        })

        // post parcel
        app.post('/parcels', async (req, res) => {
            const parcel = req.body;    // req body te jeigulo ace seigulo nibe 
            const trackingId = generateTrackingId();
            // parcel created time
            parcel.createAt = new Date();
            parcel.trackingId = trackingId;

            logTracking(trackingId, 'parcel_created');

            const result = await parcelsCollection.insertOne(parcel); // parcel insert korbe
            res.send(result);   // result ta send kore dibe
        });

        // TODO : rename tis to the specific like /parcels/:id/assign
        // patch parcel -- assign rider
        app.patch('/parcels/:id', async (req, res) => {
            const { riderId, riderName, riderEmail, trackingId } = req.body;

            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const updatedDoc = {
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }

            const result = await parcelsCollection.updateOne(query, updatedDoc);

            // update rider information
            const riderQuery = { _id: new ObjectId(riderId) };
            const riderUpdatedDoc = {
                $set: {
                    workStatus: 'in_delivery',
                }
            }
            const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);

            //log tracking
            logTracking(trackingId, 'driver_assigned');

            res.send(riderResult);

        })

        // update delivery status
        app.patch('/parcels/:id/status', async (req, res) => {
            const { deliveryStatus, riderId, trackingId } = req.body;    // must destructure deliveryStatus
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    deliveryStatus: deliveryStatus
                }
            }

            if (deliveryStatus === 'parcel_delivered') {
                // update rider information
                const riderQuery = { _id: new ObjectId(riderId) };
                const riderUpdatedDoc = {
                    $set: {
                        workStatus: 'available',
                    }
                }
                const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);
            }

            const result = await parcelsCollection.updateOne(query, updatedDoc);
            // log tracking
            logTracking(trackingId, deliveryStatus);

            res.send(result);

        })

        // delete parcel
        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const result = await parcelsCollection.deleteOne(query);
            res.send(result);
        })

        // payment related apis
        app.post('/payment-checkout-session', async (req, res) => {
            // parcel info
            const parcelInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for : ${paymentInfo.parcelName}`,
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                customer_email: paymentInfo.senderEmail,
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,
                    trackingId: paymentInfo.trackingId
                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            })

            res.send({ url: session.url })
        })

        // // old payment should not stay here
        // app.post('/create-checkout-session', async (req, res) => {
        //     const paymentInfo = req.body;
        //     const amount = parseInt(paymentInfo.cost) * 100;

        //     const session = await stripe.checkout.sessions.create({
        //         line_items: [
        //             {
        //                 // Provide the exact Price ID (for example, price_1234) of the product you want to sell
        //                 price_data: {
        //                     currency: 'USD',
        //                     unit_amount: amount,
        //                     product_data: {
        //                         name: paymentInfo.parcelName
        //                     }
        //                 },
        //                 quantity: 1,
        //             },
        //         ],
        //         customer_email: paymentInfo.senderEmail,
        //         mode: 'payment',
        //         metadata: {
        //             parcelId: paymentInfo.parcelId,
        //             parcelName: paymentInfo.parcelName
        //         },
        //         success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        //         cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        //     })

        //     console.log(session);
        //     res.send({ url: session.url });
        // })

        // update or paid
        app.patch('/payment-success', async (req, res) => {

            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            // console.log('session retrieve', session)

            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId };

            const paymentExist = await paymentCollection.findOne(query);
            console.log(paymentExist);

            if (paymentExist) {
                return res.send({
                    message: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            // use the previous tracking id not generate tracking id here
            // const trackingId = generateTrackingId();
            // take tracking from sessionid

            // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) };   // search kora id ta ke
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup'
                    }
                }

                const result = await parcelsCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customer_email: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    trackingId: trackingId,
                    paidAt: new Date(),
                }

                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentCollection.insertOne(payment);

                    logTracking(trackingId, 'parcel_paid');

                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment
                    })
                }
            }

            res.send({ success: false })
        })

        // payment history related apis
        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};

            // console.log('headers', req.headers);

            if (email) {
                query.customer_email = email

                // check email address. onno jon er email access korte dibe na.
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }
            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);

        })

        // riders related apis
        app.get('/riders', async (req, res) => {
            const { status, district, workStatus } = req.query;
            const query = {};

            if (req.query.status) {
                query.status = req.query.status;
            }
            // status district workstatus wise select
            if (status) {
                query.status = status
            }
            if (district) {
                query.district = district
            }
            if (workStatus) {
                query.workStatus = workStatus
            }

            const cursor = ridersCollection.find(query);

            const result = await cursor.toArray(cursor);
            res.send(result);
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body;
            rider.status = 'pending';
            rider.createdAt = new Date();

            const result = await ridersCollection.insertOne(rider);
            res.send(result);

        })

        // update
        app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
            const status = req.body.status;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            const result = await ridersCollection.updateOne(query, updatedDoc);

            if (status === 'approved') {
                const email = req.body.email;
                const userQuery = { email };
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await usersCollection.updateOne(userQuery, updateUser);
            }

            res.send(result);
        })

        // trackings related apis
        app.get('/trackings/:trackingId/logs', async (req, res) => {
            const trackingId = req.params.trackingId;   // id nile params diye nite hoi. and parameter teke id nile params diye nite hoi
            const query = { trackingId };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);

        })

        // delete approve
        app.delete('/riders/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };

            const result = await ridersCollection.deleteOne(query);
            res.send(result);
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Zap is shifting shifting')
})

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})