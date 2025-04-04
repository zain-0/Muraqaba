import Bus from '../models/Bus.js'; // Adjust the path as necessary

// Controller to get all buses
export const getAllBuses = async (req, res) => {
    try {
        const buses = await Bus.find(); // Fetch all buses from the database
        res.status(200).json(buses); // Return the buses as a JSON response
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Controller to get a single bus by ID
export const getBusById = async (req, res) => {
    try {
        const bus = await Bus.findById(req.params.id); // Find the bus by ID
        if (!bus) {
            return res.status(404).json({ message: 'Bus not found' });
        }
        res.status(200).json(bus); // Return the bus as a JSON response
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Controller to create a new bus
export const createBus = async (req, res) => {
    try {
        const {
            chassisNumber,
            fleetNumber,
            registrationNumber,
            make,
            model,
            year,
            engine,
            ac,
            tyre,
            transmission,
            brakePad,
        } = req.body;

        // Create a new bus with the provided data
        const newBus = new Bus({
            chassisNumber,
            fleetNumber,
            registrationNumber,
            make,
            model,
            year,
            engine,
            ac,
            tyre,
            transmission,
            brakePad,
        });

        // Save the new bus to the database
        await newBus.save();

        res.status(201).json({
            message: 'Bus created successfully',
            bus: newBus,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};
